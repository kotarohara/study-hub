// Integration tests — require the local stack: `deno task stack:up`.
// Exercise the pairing/opt-out flow with simulated Bot API updates.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  type Member,
  members,
  type Participant,
  participants,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { signToken } from "../crypto/magic_link.ts";
import { getConfig } from "../config.ts";
import { createParticipant, listChannels } from "./participants.ts";
import {
  handleTelegramUpdate,
  pairTelegram,
  stopTelegram,
  telegramPairingToken,
} from "./telegram.ts";

async function withParticipant(
  fn: (
    env: {
      db: Awaited<ReturnType<typeof getTestDb>>;
      participant: Participant;
    },
  ) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [member]: Member[] = await db
    .insert(members)
    .values([fakeMember({ email: `tg-${suffix}@studyhub.local` })])
    .returning();
  const participant = await createParticipant(db, {
    name: "Tg User",
    createdBy: member,
  });
  try {
    await fn({ db, participant });
  } finally {
    // contact_channels cascade on participant delete.
    await db.delete(participants).where(eq(participants.createdBy, member.id));
    await db.delete(members).where(inArray(members.id, [member.id]));
    await closeTestDb();
  }
}

/** A simulated Bot API update for a private-chat text message. */
function update(text: string, chatId = 70123) {
  return { update_id: 1, message: { chat: { id: chatId }, text } };
}

Deno.test("pairTelegram: a valid token creates a verified channel", async () => {
  await withParticipant(async ({ db, participant }) => {
    const token = telegramPairingToken(participant);
    const result = await pairTelegram(db, { token, chatId: "70123" });
    assert.equal(result.ok, true);
    assert.equal(result.participantCode, participant.code);

    const channels = await listChannels(db, participant.id);
    const tg = channels.filter((c) => c.kind === "telegram");
    assert.equal(tg.length, 1);
    assert.equal(tg[0].value, "70123");
    assert.equal(tg[0].verified, true);
    assert.equal(tg[0].suppressed, false);
  });
});

Deno.test("pairTelegram: re-pairing is idempotent and clears a prior /stop", async () => {
  await withParticipant(async ({ db, participant }) => {
    const token = telegramPairingToken(participant);
    await pairTelegram(db, { token, chatId: "70123" });
    await stopTelegram(db, { chatId: "70123" });

    // Suppressed after /stop…
    let tg = (await listChannels(db, participant.id))
      .filter((c) => c.kind === "telegram");
    assert.equal(tg[0].suppressed, true);

    // …re-pairing the same chat un-suppresses, without a duplicate row.
    const again = await pairTelegram(db, { token, chatId: "70123" });
    assert.equal(again.ok, true);
    tg = (await listChannels(db, participant.id))
      .filter((c) => c.kind === "telegram");
    assert.equal(tg.length, 1);
    assert.equal(tg[0].suppressed, false);
    assert.equal(tg[0].verified, true);
  });
});

Deno.test("pairTelegram: an invalid or expired token pairs nothing", async () => {
  await withParticipant(async ({ db, participant }) => {
    const bad = await pairTelegram(db, { token: "not-a-token", chatId: "1" });
    assert.equal(bad.ok, false);

    const expired = signToken(getConfig().MAGIC_LINK_SECRET, {
      purpose: "telegram_pair",
      subject: participant.id,
      ttlSeconds: 60,
      now: new Date(Date.now() - 3600_000), // signed an hour ago, 60s ttl
    });
    const result = await pairTelegram(db, { token: expired, chatId: "1" });
    assert.equal(result.ok, false);

    const channels = await listChannels(db, participant.id);
    assert.equal(channels.filter((c) => c.kind === "telegram").length, 0);
  });
});

Deno.test("stopTelegram: suppresses by chat id and is idempotent", async () => {
  await withParticipant(async ({ db, participant }) => {
    const token = telegramPairingToken(participant);
    await pairTelegram(db, { token, chatId: "70123" });

    const first = await stopTelegram(db, { chatId: "70123" });
    assert.equal(first.stopped, 1);
    const second = await stopTelegram(db, { chatId: "70123" });
    assert.equal(second.stopped, 0); // already suppressed
  });
});

Deno.test("handleTelegramUpdate: /start <token> pairs and confirms", async () => {
  await withParticipant(async ({ db, participant }) => {
    const token = telegramPairingToken(participant);
    const out = await handleTelegramUpdate(db, update(`/start ${token}`), {});
    assert.equal(out.chatId, "70123");
    assert.match(out.reply ?? "", /connected/i);

    const tg = (await listChannels(db, participant.id))
      .filter((c) => c.kind === "telegram");
    assert.equal(tg.length, 1);
    assert.equal(tg[0].verified, true);
  });
});

Deno.test("handleTelegramUpdate: bad/empty start and /stop and noise", async () => {
  await withParticipant(async ({ db, participant }) => {
    const token = telegramPairingToken(participant);
    await pairTelegram(db, { token, chatId: "70123" });

    // /start with a broken token → invalid-link reply, no change.
    const bad = await handleTelegramUpdate(db, update("/start xxx"), {});
    assert.match(bad.reply ?? "", /invalid|expired/i);

    // bare /start and free text → help.
    assert.match(
      (await handleTelegramUpdate(db, update("/start"), {})).reply ?? "",
      /pairing link|reminders/i,
    );
    assert.match(
      (await handleTelegramUpdate(db, update("hello"), {})).reply ?? "",
      /pairing link|reminders/i,
    );

    // /stop suppresses and confirms.
    const stop = await handleTelegramUpdate(db, update("/stop"), {});
    assert.match(stop.reply ?? "", /email instead/i);
    const tg = (await listChannels(db, participant.id))
      .filter((c) => c.kind === "telegram");
    assert.equal(tg[0].suppressed, true);

    // An unparseable update is a silent no-op.
    const noop = await handleTelegramUpdate(db, { junk: true }, {});
    assert.deepEqual(noop, { chatId: null, reply: null });
  });
});
