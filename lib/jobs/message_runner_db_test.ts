// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  type Enrollment,
  members,
  messages,
  participants,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "../objects/projects.ts";
import { createStudy } from "../objects/studies.ts";
import { createParticipant } from "../objects/participants.ts";
import { createEnrollment } from "../objects/enrollments.ts";
import { enqueueMessage } from "../objects/messaging.ts";
import { FakeAdapter } from "../integrations/fake_channel.ts";
import { resetAlertSink, setAlertSink } from "./alerts.ts";
import { runDueMessages } from "./message_runner.ts";

const FIELDS = {
  first_name: "Ada",
  study_title: "Maps Study",
  session_time: "soon",
  session_location: "",
};

const HOUR = 60 * 60 * 1000;

async function withEnv(
  fn: (env: { study: Study; enrollment: Enrollment }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `run-res-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `run-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Maps Study",
    methodology: "survey",
    createdBy: researcher,
  });
  const participant = await createParticipant(db, {
    name: "Ada Run",
    createdBy: researcher,
  });
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: researcher,
  });
  try {
    await fn({ study, enrollment });
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

function enqueue(
  db: Awaited<ReturnType<typeof getTestDb>>,
  enrollmentId: string,
  extra: { idempotencyKey?: string; nextAttemptAt?: Date } = {},
) {
  return enqueueMessage(db, {
    channel: "email",
    to: "ada@example.com",
    templateKey: "booking_confirmation",
    fields: FIELDS,
    enrollmentId,
    ...extra,
  });
}

Deno.test("runner delivers due messages and never re-sends (duplicate-send prevention)", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    const adapter = new FakeAdapter("email");
    await enqueue(db, enrollment.id);
    await enqueue(db, enrollment.id);

    const first = await runDueMessages(db, { adapter });
    assert.equal(first.claimed, 2);
    assert.equal(first.delivered, 2);
    assert.equal(adapter.sent.length, 2);

    // A second tick finds nothing queued and sends nothing more.
    const second = await runDueMessages(db, { adapter });
    assert.equal(second.claimed, 0);
    assert.equal(adapter.sent.length, 2);
  });
});

Deno.test("runner retries with backoff, then fails permanently and alerts", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    const adapter = new FakeAdapter("email");
    adapter.failWith = "smtp down";
    const alerts: string[] = [];
    setAlertSink({ notify: (a) => void alerts.push(a.kind) });

    try {
      const { message } = await enqueue(db, enrollment.id);
      const t0 = new Date();

      // First attempt fails → scheduled for retry, not yet permanent.
      const r1 = await runDueMessages(db, { adapter, maxAttempts: 3, now: t0 });
      assert.deepEqual(
        [r1.claimed, r1.delivered, r1.retriesScheduled, r1.failedPermanently],
        [1, 0, 1, 0],
      );

      // Still within backoff → not due, nothing claimed.
      const held = await runDueMessages(db, {
        adapter,
        maxAttempts: 3,
        now: t0,
      });
      assert.equal(held.claimed, 0);

      // Past the backoff → second attempt, fails, scheduled again.
      const r2 = await runDueMessages(db, {
        adapter,
        maxAttempts: 3,
        now: new Date(t0.getTime() + HOUR),
      });
      assert.equal(r2.retriesScheduled, 1);

      // Third attempt hits maxAttempts → permanent failure + alert.
      const r3 = await runDueMessages(db, {
        adapter,
        maxAttempts: 3,
        now: new Date(t0.getTime() + 2 * HOUR),
      });
      assert.equal(r3.failedPermanently, 1);
      assert.ok(alerts.includes("message.delivery_failed"));

      // Exhausted message is no longer picked up.
      const after = await runDueMessages(db, {
        adapter,
        maxAttempts: 3,
        now: new Date(t0.getTime() + 10 * HOUR),
      });
      assert.equal(after.claimed, 0);

      const [row] = await db
        .select({ status: messages.status, attempts: messages.attempts })
        .from(messages)
        .where(eq(messages.id, message.id));
      assert.equal(row.status, "failed");
      assert.equal(row.attempts, 3);
    } finally {
      resetAlertSink();
    }
  });
});

Deno.test("runner holds a scheduled message until its time arrives", async () => {
  await withEnv(async ({ enrollment }) => {
    const db = await getTestDb();
    const adapter = new FakeAdapter("email");
    const now = new Date();
    await enqueue(db, enrollment.id, {
      nextAttemptAt: new Date(now.getTime() + HOUR),
    });

    // Not due yet.
    assert.equal((await runDueMessages(db, { adapter, now })).claimed, 0);
    assert.equal(adapter.sent.length, 0);

    // Due now.
    const later = await runDueMessages(db, {
      adapter,
      now: new Date(now.getTime() + 2 * HOUR),
    });
    assert.equal(later.delivered, 1);
    assert.equal(adapter.sent.length, 1);
  });
});
