// Telegram pairing + opt-out domain logic (spec §3.7). A participant has no
// account, so we connect their Telegram chat with a one-time, purpose-scoped
// magic link: the lab issues `t.me/<bot>?start=<token>`, the participant taps
// it, and the bot receives `/start <token>`. Verifying the token turns their
// chat into a *verified* telegram ContactChannel — which the notification
// layer then prefers over email. `/stop` suppresses that channel, so
// reminders fall back to email without losing the pairing.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { contactChannels, type Participant } from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import { channelIndex } from "../crypto/blind_index.ts";
import { signToken, TokenError, verifyToken } from "../crypto/magic_link.ts";
import { pairingDeepLink } from "../integrations/telegram.ts";
import { parseUpdate } from "../integrations/telegram_update.ts";
import { getParticipant } from "./participants.ts";
import type { AuditCtx } from "./studies.ts";

/** Pairing links live a week — long enough to act on, short enough to age
 * out an unused invite. */
export const TELEGRAM_PAIR_TTL_SECONDS = 7 * 24 * 60 * 60;

const PAIR_PURPOSE = "telegram_pair";

/** Mirrors the wording of every other participant-facing reply. */
const REPLY = {
  paired:
    "✅ You're connected to StudyHub. We'll send your session reminders here.\n\nSend /stop any time to switch back to email.",
  invalid:
    "Sorry — this pairing link is invalid or has expired. Please ask the research team for a new one.",
  stopped:
    "👍 Done. You won't receive Telegram messages from StudyHub — we'll email you instead.",
  help:
    "Hi! This bot delivers StudyHub study reminders. Tap the pairing link from your research team to connect, or send /stop to opt out.",
} as const;

/** Signs a one-time pairing token bound to a participant (pseudonymous id
 * only — never PII in the token). */
export function telegramPairingToken(participant: Participant): string {
  return signToken(getConfig().MAGIC_LINK_SECRET, {
    purpose: PAIR_PURPOSE,
    subject: participant.id,
    ttlSeconds: TELEGRAM_PAIR_TTL_SECONDS,
  });
}

/** The tap-to-pair deep link, or null when no bot username is configured
 * (Telegram disabled — the link would be unusable). */
export function telegramDeepLink(participant: Participant): string | null {
  const username = getConfig().TELEGRAM_BOT_USERNAME;
  if (!username) return null;
  return pairingDeepLink(username, telegramPairingToken(participant));
}

/** Token → participant id, or null for any invalid/expired/foreign token. */
export function verifyPairingToken(token: string): string | null {
  try {
    return verifyToken(getConfig().MAGIC_LINK_SECRET, token, {
      purpose: PAIR_PURPOSE,
    }).subject;
  } catch (err) {
    if (err instanceof TokenError) return null;
    throw err;
  }
}

export interface PairResult {
  ok: boolean;
  /** Pseudonymous code of the paired participant, when ok. */
  participantCode?: string;
}

/**
 * Connects a Telegram chat to the participant named in the token, as a
 * verified, un-suppressed contact channel. Idempotent: re-pairing the same
 * chat re-verifies and clears any prior `/stop` suppression rather than
 * stacking duplicate rows.
 */
export async function pairTelegram(
  db: Db,
  opts: { token: string; chatId: string } & AuditCtx,
): Promise<PairResult> {
  const participantId = verifyPairingToken(opts.token);
  if (!participantId) return { ok: false };
  const participant = await getParticipant(db, participantId);
  if (!participant) return { ok: false };

  const valueIndex = channelIndex(
    getConfig().PII_INDEX_SECRET,
    "telegram",
    opts.chatId,
  );

  const [existing] = await db
    .select({ id: contactChannels.id })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.participantId, participant.id),
        eq(contactChannels.kind, "telegram"),
        eq(contactChannels.valueIndex, valueIndex),
      ),
    );

  if (existing) {
    await db
      .update(contactChannels)
      .set({ value: opts.chatId, verified: true, suppressed: false })
      .where(eq(contactChannels.id, existing.id));
  } else {
    await db.insert(contactChannels).values({
      participantId: participant.id,
      kind: "telegram",
      value: opts.chatId,
      valueIndex,
      verified: true,
    });
  }

  await audit(db, {
    action: "participant.telegram_paired",
    actorId: null, // participant-initiated, no member actor
    objectType: "participant",
    objectId: participant.id,
    details: { code: participant.code },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return { ok: true, participantCode: participant.code };
}

/**
 * Opts a chat out of Telegram by suppressing every telegram channel holding
 * that chat id (matched by blind index, so the chat id never appears in the
 * query). Reminders then fall back to email. Returns how many were stopped.
 */
export async function stopTelegram(
  db: Db,
  opts: { chatId: string } & AuditCtx,
): Promise<{ stopped: number }> {
  const valueIndex = channelIndex(
    getConfig().PII_INDEX_SECRET,
    "telegram",
    opts.chatId,
  );
  const rows = await db
    .update(contactChannels)
    .set({ suppressed: true })
    .where(
      and(
        eq(contactChannels.kind, "telegram"),
        eq(contactChannels.valueIndex, valueIndex),
        eq(contactChannels.suppressed, false),
      ),
    )
    .returning({ participantId: contactChannels.participantId });

  for (const row of rows) {
    await audit(db, {
      action: "channel.suppressed",
      actorId: null,
      objectType: "participant",
      objectId: row.participantId,
      details: { reason: "telegram_stop", kind: "telegram" },
      requestId: opts.requestId,
      ip: opts.ip,
    });
  }
  return { stopped: rows.length };
}

export interface UpdateOutcome {
  /** Chat to reply to, or null when the update was ignored. */
  chatId: string | null;
  /** Reply text to send back, or null when nothing should be sent. */
  reply: string | null;
}

/**
 * Handles one inbound Bot API update end to end: parses it, applies the
 * pairing or opt-out, and returns the chat + reply text the webhook should
 * send. Pure of any HTTP — the route does the sending — so the whole flow is
 * testable with simulated payloads.
 */
export async function handleTelegramUpdate(
  db: Db,
  raw: unknown,
  auditCtx: AuditCtx,
): Promise<UpdateOutcome> {
  const command = parseUpdate(raw);
  switch (command.kind) {
    case "ignore":
      return { chatId: null, reply: null };
    case "start": {
      if (!command.token) {
        return { chatId: command.chatId, reply: REPLY.help };
      }
      const result = await pairTelegram(db, {
        token: command.token,
        chatId: command.chatId,
        ...auditCtx,
      });
      return {
        chatId: command.chatId,
        reply: result.ok ? REPLY.paired : REPLY.invalid,
      };
    }
    case "stop":
      await stopTelegram(db, { chatId: command.chatId, ...auditCtx });
      return { chatId: command.chatId, reply: REPLY.stopped };
    case "other":
      return { chatId: command.chatId, reply: REPLY.help };
  }
}
