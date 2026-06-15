// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  type Enrollment,
  type Member,
  members,
  messages,
  type Participant,
  participants,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { isEncrypted } from "../crypto/encryption.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment } from "./enrollments.ts";
import {
  deliverMessage,
  enqueueMessage,
  listMessagesOfEnrollment,
  MessagingError,
} from "./messaging.ts";
import { FakeAdapter } from "../integrations/fake_channel.ts";

const FIELDS = {
  first_name: "Ada",
  study_title: "Maps Study",
  session_time: "Mon 1 Jul, 10:00",
  session_location: " at Lab 3A",
};

async function withEnv(
  fn: (env: {
    researcher: Member;
    study: Study;
    enrollment: Enrollment;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `msg-res-${suffix}@studyhub.local` })])
    .returning();
  const project: Project = await createProject(db, {
    name: `msg-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Maps Study",
    methodology: "interview",
    createdBy: researcher,
  });
  const participant: Participant = await createParticipant(db, {
    name: "Ada Msg",
    createdBy: researcher,
  });
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: researcher,
  });
  try {
    await fn({ researcher, study, enrollment });
  } finally {
    // messages.enrollment_id is SET NULL on enrollment delete, so clear
    // the test's messages before the project cascade nulls the link.
    await db.delete(messages).where(eq(messages.enrollmentId, enrollment.id));
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db.delete(members).where(inArray(members.id, [researcher.id]));
    await closeTestDb();
  }
}

Deno.test("enqueue: renders, encrypts recipient/subject/body at rest", async () => {
  await withEnv(async ({ study, enrollment }) => {
    const db = await getTestDb();
    const { message, deduped } = await enqueueMessage(db, {
      channel: "email",
      to: "ada@example.com",
      templateKey: "booking_confirmation",
      fields: FIELDS,
      enrollmentId: enrollment.id,
    });
    assert.equal(deduped, false);
    assert.equal(message.status, "queued");
    // Read-through decrypts.
    assert.equal(message.recipient, "ada@example.com");
    assert.ok(message.body.includes("Hi Ada,"));
    assert.equal(message.subject, "Your Maps Study session is booked");

    // What the database stores is ciphertext (spec §4).
    const raw = await db.execute<
      { recipient: string; subject: string; body: string }
    >(sql`select recipient, subject, body from messages where id = ${message.id}`);
    assert.ok(isEncrypted(raw[0].recipient));
    assert.ok(isEncrypted(raw[0].subject));
    assert.ok(isEncrypted(raw[0].body));
    assert.ok(!raw[0].recipient.includes("ada@example.com"));
    assert.ok(!raw[0].body.includes("Ada"));

    void study;
  });
});

Deno.test("enqueue: unknown template/missing field is rejected before insert", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    await assert.rejects(
      () =>
        enqueueMessage(db, {
          channel: "email",
          to: "x@example.com",
          templateKey: "session_reminder",
          fields: { first_name: "Ada" }, // missing study_title etc.
          enrollmentId: enrollment.id,
        }),
      /Unresolved merge field/,
    );
    // Nothing was logged.
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.enrollmentId, enrollment.id));
    assert.equal(rows.length, 0);
  });
});

Deno.test("enqueue: idempotency key dedupes a repeat", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    const key = `book-${enrollment.id}`;
    const first = await enqueueMessage(db, {
      channel: "email",
      to: "ada@example.com",
      templateKey: "booking_confirmation",
      fields: FIELDS,
      enrollmentId: enrollment.id,
      idempotencyKey: key,
    });
    const second = await enqueueMessage(db, {
      channel: "email",
      to: "ada@example.com",
      templateKey: "booking_confirmation",
      fields: FIELDS,
      enrollmentId: enrollment.id,
      idempotencyKey: key,
    });
    assert.equal(second.deduped, true);
    assert.equal(second.message.id, first.message.id);
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.enrollmentId, enrollment.id));
    assert.equal(rows.length, 1);
  });
});

Deno.test("deliver: success and failure update the log; no adapter fails cleanly", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    const adapter = new FakeAdapter("email");

    const { message } = await enqueueMessage(db, {
      channel: "email",
      to: "ada@example.com",
      templateKey: "booking_confirmation",
      fields: FIELDS,
      enrollmentId: enrollment.id,
    });

    const sent = await deliverMessage(db, message.id, adapter);
    assert.equal(sent.status, "sent");
    assert.equal(sent.attempts, 1);
    assert.ok(sent.providerMessageId);
    assert.ok(sent.sentAt);
    // The adapter received the decrypted content.
    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0].to, "ada@example.com");
    assert.ok(adapter.sent[0].body.includes("Hi Ada,"));

    // Re-delivering an already-sent message is a no-op (idempotent).
    const again = await deliverMessage(db, message.id, adapter);
    assert.equal(again.attempts, 1);
    assert.equal(adapter.sent.length, 1);

    // Failure path bumps attempts and records the error.
    const { message: m2 } = await enqueueMessage(db, {
      channel: "email",
      to: "bo@example.com",
      templateKey: "session_reminder",
      fields: { ...FIELDS, first_name: "Bo" },
      enrollmentId: enrollment.id,
    });
    adapter.failWith = "smtp down";
    const failed = await deliverMessage(db, m2.id, adapter);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.lastError, "smtp down");
    assert.equal(failed.sentAt, null);

    // No adapter registered and none injected → failed with a clear reason.
    const { message: m3 } = await enqueueMessage(db, {
      channel: "telegram",
      to: "@ada",
      templateKey: "session_reminder",
      fields: FIELDS,
      enrollmentId: enrollment.id,
    });
    const noAdapter = await deliverMessage(db, m3.id);
    assert.equal(noAdapter.status, "failed");
    assert.match(noAdapter.lastError ?? "", /No adapter/);

    // Delivery log exposes status without PII columns.
    const log = await listMessagesOfEnrollment(db, enrollment.id);
    assert.equal(log.length, 3);
    assert.ok(log.every((r) => "status" in r && !("body" in r)));
  });
});

Deno.test("enqueue: empty recipient is rejected", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    await assert.rejects(
      () =>
        enqueueMessage(db, {
          channel: "email",
          to: "  ",
          templateKey: "booking_confirmation",
          fields: FIELDS,
          enrollmentId: enrollment.id,
        }),
      MessagingError,
    );
  });
});
