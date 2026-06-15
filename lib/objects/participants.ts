// Participant pool domain logic (spec §3.4). PII lives ONLY here and on
// contact channels, encrypted at rest; everything that leaves this area
// (datasets, exports, Discord, Notion) uses the pseudonymous `code`.
// Reads of name/channel values are PII views — route handlers audit them.
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type ContactChannel,
  type ContactChannelKind,
  contactChannels,
  type Member,
  type Participant,
  participants,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import { channelIndex } from "../crypto/blind_index.ts";
import type { AuditCtx } from "./studies.ts";

export class ParticipantError extends Error {}

export const CHANNEL_KINDS: ContactChannelKind[] = [
  "email",
  "telegram",
  "phone",
  "paypal",
  "prolific",
];

export interface ChannelInput {
  kind: ContactChannelKind;
  value: string;
}

export interface DuplicateWarning {
  kind: ContactChannelKind;
  /** Pseudonymous codes of participants already using this value. */
  participantCodes: string[];
}

function indexOf(channel: ChannelInput): string {
  return channelIndex(
    getConfig().PII_INDEX_SECRET,
    channel.kind,
    channel.value,
  );
}

/** Cross-pool dedup (spec §3.4): warns, never hard-blocks — the same
 * email legitimately appears twice when e.g. a household shares one. */
export async function findDuplicates(
  db: Db,
  channels: ChannelInput[],
  excludeParticipantId?: string,
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  for (const channel of channels) {
    if (!channel.value.trim()) continue;
    const matches = await db
      .select({ code: participants.code })
      .from(contactChannels)
      .innerJoin(
        participants,
        eq(contactChannels.participantId, participants.id),
      )
      .where(
        excludeParticipantId
          ? and(
            eq(contactChannels.valueIndex, indexOf(channel)),
            ne(contactChannels.participantId, excludeParticipantId),
          )
          : eq(contactChannels.valueIndex, indexOf(channel)),
      );
    if (matches.length > 0) {
      warnings.push({
        kind: channel.kind,
        participantCodes: [...new Set(matches.map((m) => m.code))],
      });
    }
  }
  return warnings;
}

export interface ParticipantInput {
  name: string;
  notes?: string;
  yearOfBirth?: number | null;
  gender?: string;
  source?: string;
}

function validateInput(input: ParticipantInput) {
  if (!input.name.trim()) {
    throw new ParticipantError("Participant name is required.");
  }
  const year = input.yearOfBirth;
  if (year !== null && year !== undefined) {
    const current = new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < current - 120 || year > current) {
      throw new ParticipantError("Year of birth looks implausible.");
    }
  }
}

function newCode(): string {
  return `P-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createParticipant(
  db: Db,
  opts: ParticipantInput & {
    channels?: ChannelInput[];
    /** Null for self-registration via a public screener (no member). */
    createdBy: Member | null;
  } & AuditCtx,
): Promise<Participant> {
  validateInput(opts);
  const channels = (opts.channels ?? []).filter((c) => c.value.trim());

  return await db.transaction(async (tx) => {
    const [participant] = await tx
      .insert(participants)
      .values({
        code: newCode(),
        name: opts.name.trim(),
        notes: opts.notes?.trim() ?? "",
        yearOfBirth: opts.yearOfBirth ?? null,
        gender: opts.gender?.trim() ?? "",
        source: opts.source?.trim() ?? "",
        createdBy: opts.createdBy?.id ?? null,
      })
      .returning();
    if (channels.length > 0) {
      await tx.insert(contactChannels).values(
        channels.map((c) => ({
          participantId: participant.id,
          kind: c.kind,
          value: c.value.trim(),
          valueIndex: indexOf(c),
        })),
      );
    }
    await audit(tx, {
      action: "participant.created",
      actorId: opts.createdBy?.id ?? null,
      objectType: "participant",
      objectId: participant.id,
      // Pseudonymous code only — audit details must never contain PII.
      details: {
        code: participant.code,
        channels: channels.map((c) => c.kind),
      },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return participant;
  });
}

export async function updateParticipant(
  db: Db,
  opts: ParticipantInput & {
    participant: Participant;
    actor: Member;
  } & AuditCtx,
): Promise<Participant> {
  validateInput(opts);
  const [updated] = await db
    .update(participants)
    .set({
      name: opts.name.trim(),
      notes: opts.notes?.trim() ?? "",
      yearOfBirth: opts.yearOfBirth ?? null,
      gender: opts.gender?.trim() ?? "",
      source: opts.source?.trim() ?? "",
      updatedAt: new Date(),
    })
    .where(eq(participants.id, opts.participant.id))
    .returning();
  await audit(db, {
    action: "participant.updated",
    actorId: opts.actor.id,
    objectType: "participant",
    objectId: opts.participant.id,
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

/** The do-not-contact flag (spec §3.4) is consent-adjacent → audited. */
export async function setDoNotContact(
  db: Db,
  opts:
    & { participant: Participant; doNotContact: boolean; actor: Member }
    & AuditCtx,
): Promise<Participant> {
  const [updated] = await db
    .update(participants)
    .set({ doNotContact: opts.doNotContact, updatedAt: new Date() })
    .where(eq(participants.id, opts.participant.id))
    .returning();
  await audit(db, {
    action: "participant.do_not_contact_changed",
    actorId: opts.actor.id,
    objectType: "participant",
    objectId: opts.participant.id,
    details: { doNotContact: opts.doNotContact },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function addChannel(
  db: Db,
  opts:
    & { participant: Participant; channel: ChannelInput; actor: Member }
    & AuditCtx,
): Promise<ContactChannel> {
  const value = opts.channel.value.trim();
  if (!value) throw new ParticipantError("Channel value is required.");
  const [channel] = await db
    .insert(contactChannels)
    .values({
      participantId: opts.participant.id,
      kind: opts.channel.kind,
      value,
      valueIndex: indexOf(opts.channel),
    })
    .returning();
  await audit(db, {
    action: "participant.channel_added",
    actorId: opts.actor.id,
    objectType: "participant",
    objectId: opts.participant.id,
    details: { kind: opts.channel.kind },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return channel;
}

/** Removing a contact channel is a PII deletion → audited. */
export async function removeChannel(
  db: Db,
  opts:
    & { participant: Participant; channelId: string; actor: Member }
    & AuditCtx,
): Promise<void> {
  const removed = await db
    .delete(contactChannels)
    .where(
      and(
        eq(contactChannels.id, opts.channelId),
        eq(contactChannels.participantId, opts.participant.id),
      ),
    )
    .returning();
  if (removed.length === 0) return;
  await audit(db, {
    action: "participant.channel_removed",
    actorId: opts.actor.id,
    objectType: "participant",
    objectId: opts.participant.id,
    details: { kind: removed[0].kind },
    requestId: opts.requestId,
    ip: opts.ip,
  });
}

export async function setPreferredChannel(
  db: Db,
  opts: { participant: Participant; channelId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(contactChannels)
      .set({ isPreferred: false })
      .where(eq(contactChannels.participantId, opts.participant.id));
    await tx
      .update(contactChannels)
      .set({ isPreferred: true })
      .where(
        and(
          eq(contactChannels.id, opts.channelId),
          eq(contactChannels.participantId, opts.participant.id),
        ),
      );
  });
}

export async function getParticipant(
  db: Db,
  participantId: string,
): Promise<Participant | null> {
  const participant = await db.query.participants.findFirst({
    where: eq(participants.id, participantId),
  });
  return participant ?? null;
}

export async function listParticipants(db: Db): Promise<Participant[]> {
  return await db.select().from(participants).orderBy(asc(participants.code));
}

export async function listChannels(
  db: Db,
  participantId: string,
): Promise<ContactChannel[]> {
  return await db
    .select()
    .from(contactChannels)
    .where(eq(contactChannels.participantId, participantId))
    .orderBy(asc(contactChannels.createdAt));
}

/** Channel counts per participant for the collection view (no PII). */
export async function channelCounts(
  db: Db,
  participantIds: string[],
): Promise<Map<string, number>> {
  if (participantIds.length === 0) return new Map();
  const rows = await db
    .select({ participantId: contactChannels.participantId })
    .from(contactChannels)
    .where(inArray(contactChannels.participantId, participantIds));
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.participantId, (counts.get(row.participantId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Suppresses email contact channels whose address hard-bounced or
 * complained (spec §3.8 bounce webhook). Matched by blind index, so the
 * plaintext address never appears in the query or the audit trail. Each
 * affected channel is flagged `suppressed` so later sends skip it.
 * Participant-initiated (no member actor). Returns the count suppressed.
 */
export async function suppressEmailChannels(
  db: Db,
  emails: string[],
  opts: { reason: "bounce" | "complaint" } & AuditCtx,
): Promise<number> {
  const cleaned = emails.map((e) => e.trim()).filter((e) => e.includes("@"));
  if (cleaned.length === 0) return 0;
  const secret = getConfig().PII_INDEX_SECRET;
  const indexes = cleaned.map((e) => channelIndex(secret, "email", e));

  const rows = await db
    .select({
      id: contactChannels.id,
      participantId: contactChannels.participantId,
    })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.kind, "email"),
        inArray(contactChannels.valueIndex, indexes),
        eq(contactChannels.suppressed, false),
      ),
    );
  if (rows.length === 0) return 0;

  await db
    .update(contactChannels)
    .set({ suppressed: true })
    .where(inArray(contactChannels.id, rows.map((r) => r.id)));

  for (const row of rows) {
    await audit(db, {
      action: "channel.suppressed",
      actorId: null,
      objectType: "participant",
      objectId: row.participantId,
      // No PII — reason only; the address is identified by blind index.
      details: { reason: opts.reason, kind: "email" },
      requestId: opts.requestId,
      ip: opts.ip,
    });
  }
  return rows.length;
}
