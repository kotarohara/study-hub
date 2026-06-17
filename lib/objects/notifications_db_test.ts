// Integration tests — require the local stack: `deno task stack:up`
// (Postgres for all; Mailpit for the end-to-end test).
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  contactChannels,
  type Enrollment,
  type Member,
  members,
  messages,
  type Participant,
  participants,
  projects,
  type Study,
  type StudySession,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { loadConfig } from "../config.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment } from "./enrollments.ts";
import { bookSession, cancelBooking, publishSlot } from "./sessions.ts";
import { listMessagesOfStudy, type StudyMessageLogRow } from "./messaging.ts";
import { notifyBookingConfirmed, sweepDueReminders } from "./notifications.ts";
import {
  pairTelegram,
  stopTelegram,
  telegramPairingToken,
} from "./telegram.ts";
import { runDueMessages } from "../jobs/message_runner.ts";
import { EmailAdapter } from "../integrations/email.ts";

const HOUR = 60 * 60 * 1000;

interface Env {
  researcher: Member;
  study: Study;
  participant: Participant;
  enrollment: Enrollment;
}

async function withEnv(
  fn: (env: Env) => Promise<void>,
  opts: { email?: string | null; doNotContact?: boolean } = {},
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `notif-res-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `notif-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Maps Study",
    methodology: "interview",
    createdBy: researcher,
  });
  const email = opts.email === undefined ? "ada@example.com" : opts.email;
  const participant = await createParticipant(db, {
    name: "Ada Notify",
    createdBy: researcher,
    channels: email ? [{ kind: "email", value: email }] : [],
  });
  if (opts.doNotContact) {
    await db
      .update(participants)
      .set({ doNotContact: true })
      .where(eq(participants.id, participant.id));
  }
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: researcher,
  });
  try {
    await fn({ researcher, study, participant, enrollment });
  } finally {
    await db.delete(messages).where(eq(messages.enrollmentId, enrollment.id));
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db.delete(members).where(inArray(members.id, [researcher.id]));
    await closeTestDb();
  }
}

/** Publishes a slot starting `inMs` from now and books it for the env's
 * enrollment, returning the booked session. */
async function bookSlot(env: Env, inMs: number): Promise<StudySession> {
  const db = await getTestDb();
  const startsAt = new Date(Date.now() + inMs);
  const slot = await publishSlot(db, {
    study: env.study,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    location: "Lab 3A",
    actor: env.researcher,
  });
  return await bookSession(db, {
    session: slot,
    enrollment: env.enrollment,
    actor: env.researcher,
  });
}

Deno.test("booking confirmation: enqueues a rendered, idempotent message", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const session = await bookSlot(env, 48 * HOUR);

    const first = await notifyBookingConfirmed(db, session.id);
    assert.equal(first.enqueued, true);

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.enrollmentId, env.enrollment.id));
    assert.equal(rows.length, 1);
    const msg = rows[0];
    assert.equal(msg.templateKey, "booking_confirmation");
    assert.equal(msg.idempotencyKey, `confirm:${session.id}`);
    // Read-through decrypts: fields are resolved, location uses " at X".
    assert.equal(msg.recipient, "ada@example.com");
    assert.equal(msg.subject, "Your Maps Study session is booked");
    assert.ok(msg.body.includes("Hi Ada,"));
    assert.ok(msg.body.includes("at Lab 3A"));

    // A repeat confirmation for the same session is a no-op.
    const again = await notifyBookingConfirmed(db, session.id);
    assert.equal(again.enqueued, true); // dedupe is transparent to the caller
    const after = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.enrollmentId, env.enrollment.id));
    assert.equal(after.length, 1);
  });
});

Deno.test("booking confirmation: skips an open (unbooked) session", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const slot = await publishSlot(db, {
      study: env.study,
      startsAt: new Date(Date.now() + 48 * HOUR),
      endsAt: new Date(Date.now() + 49 * HOUR),
      actor: env.researcher,
    });
    const result = await notifyBookingConfirmed(db, slot.id);
    assert.equal(result.enqueued, false);
    assert.equal(result.reason, "not_booked");
  });
});

Deno.test("booking confirmation: skips a do-not-contact participant", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const session = await bookSlot(env, 48 * HOUR);
    const result = await notifyBookingConfirmed(db, session.id);
    assert.equal(result.enqueued, false);
    assert.equal(result.reason, "do_not_contact");
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.enrollmentId, env.enrollment.id));
    assert.equal(rows.length, 0);
  }, { doNotContact: true });
});

Deno.test("booking confirmation: skips a participant with no email channel", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const session = await bookSlot(env, 48 * HOUR);
    const result = await notifyBookingConfirmed(db, session.id);
    assert.equal(result.enqueued, false);
    assert.equal(result.reason, "no_channel");
  }, { email: null });
});

Deno.test("booking confirmation: skips a suppressed (bounced) email channel", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    // Bounce suppression flags the only email channel.
    await db
      .update(contactChannels)
      .set({ suppressed: true })
      .where(eq(contactChannels.participantId, env.participant.id));
    const session = await bookSlot(env, 48 * HOUR);
    const result = await notifyBookingConfirmed(db, session.id);
    assert.equal(result.enqueued, false);
    assert.equal(result.reason, "no_channel");
  });
});

Deno.test("reminder sweep: reminds sessions inside the lead window only", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const soon = await bookSlot(env, 6 * HOUR); // inside 24h
    const later = await bookSlot(env, 48 * HOUR); // outside 24h

    const swept = await sweepDueReminders(db);
    assert.equal(swept.enqueued, 1);

    const rows = await db
      .select({ key: messages.idempotencyKey })
      .from(messages)
      .where(eq(messages.enrollmentId, env.enrollment.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, `reminder:${soon.id}`);
    void later;
  });
});

Deno.test("reminder sweep: idempotent across repeated runs", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    await bookSlot(env, 6 * HOUR);

    const first = await sweepDueReminders(db);
    assert.equal(first.enqueued, 1);
    const second = await sweepDueReminders(db);
    assert.equal(second.enqueued, 0);
    assert.equal(second.skipped, 1); // deduped

    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.enrollmentId, env.enrollment.id));
    assert.equal(rows.length, 1);
  });
});

Deno.test("reminder sweep: a cancelled session is not reminded", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const session = await bookSlot(env, 6 * HOUR);
    await cancelBooking(db, { session, actor: env.researcher });

    const swept = await sweepDueReminders(db);
    assert.equal(swept.enqueued, 0);
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.enrollmentId, env.enrollment.id));
    assert.equal(rows.length, 0);
  });
});

Deno.test("study message log is pseudonymous (participant code, no PII)", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const session = await bookSlot(env, 48 * HOUR);
    await notifyBookingConfirmed(db, session.id);

    const log: StudyMessageLogRow[] = await listMessagesOfStudy(
      db,
      env.study.id,
    );
    assert.equal(log.length, 1);
    assert.equal(log[0].participantCode, env.participant.code);
    // No PII columns leak into the log shape.
    assert.ok(!("recipient" in log[0]));
    assert.ok(!("body" in log[0]));
    assert.ok(!("subject" in log[0]));
  });
});

Deno.test("channel choice: a verified Telegram chat wins; /stop falls back to email", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    await pairTelegram(db, {
      token: telegramPairingToken(env.participant),
      chatId: "880",
    });

    // With Telegram paired, the confirmation goes to Telegram.
    const s1 = await bookSlot(env, 48 * HOUR);
    await notifyBookingConfirmed(db, s1.id);
    const m1 = await db
      .select({ channel: messages.channel, recipient: messages.recipient })
      .from(messages)
      .where(eq(messages.sessionId, s1.id));
    assert.equal(m1.length, 1);
    assert.equal(m1[0].channel, "telegram");
    assert.equal(m1[0].recipient, "880");

    // After /stop, a fresh booking falls back to the email channel.
    await stopTelegram(db, { chatId: "880" });
    const s2 = await bookSlot(env, 49 * HOUR);
    await notifyBookingConfirmed(db, s2.id);
    const m2 = await db
      .select({ channel: messages.channel, recipient: messages.recipient })
      .from(messages)
      .where(eq(messages.sessionId, s2.id));
    assert.equal(m2.length, 1);
    assert.equal(m2[0].channel, "email");
    assert.equal(m2[0].recipient, "ada@example.com");
  });
});

Deno.test("end-to-end: a booking confirmation lands in Mailpit", async () => {
  await withEnv(async (env) => {
    const db = await getTestDb();
    const session = await bookSlot(env, 48 * HOUR);
    // Route the recipient to a unique marker address so the Mailpit search
    // is isolated from other tests.
    const marker = crypto.randomUUID();
    const address = `notif-${marker}@example.com`;
    await db
      .update(contactChannels)
      .set({ value: address })
      .where(eq(contactChannels.participantId, env.participant.id));

    await notifyBookingConfirmed(db, session.id);

    const adapter = new EmailAdapter(loadConfig({}));
    const summary = await runDueMessages(db, { adapter });
    assert.equal(summary.delivered, 1);

    const MAILPIT = "http://localhost:8025";
    interface MailpitMessage {
      ID: string;
      Subject: string;
      To: { Address: string }[];
    }
    let found: MailpitMessage | undefined;
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      const res = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(address)}`,
      );
      const data = await res.json() as { messages: MailpitMessage[] };
      found = data.messages.find((m) => m.To[0]?.Address === address);
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(found, "confirmation did not arrive in Mailpit");
    assert.equal(found.Subject, "Your Maps Study session is booked");

    const detail = await (await fetch(`${MAILPIT}/api/v1/message/${found.ID}`))
      .json() as { Text: string };
    assert.ok(detail.Text.includes("Hi Ada,"));

    await fetch(`${MAILPIT}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: [found.ID] }),
    });
  });
});
