// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { asc, eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  diaryPrompts,
  diaryResponses,
  type Enrollment,
  enrollments,
  type Instrument,
  instruments,
  type Member,
  members,
  messages,
  type Participant,
  participants,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment } from "./enrollments.ts";
import { createInstrument } from "./instruments.ts";
import {
  listDatasetsOfStudy,
  listRecords,
  RESPONSES_DATASET,
} from "./datasets.ts";
import type { FormItem } from "./forms.ts";
import {
  configureDiary,
  diaryProgress,
  generatePrompts,
  generatePromptsForActive,
  getDiarySchedule,
  submitDiaryEntry,
  sweepDueDiaryPrompts,
} from "./diary.ts";
import { runDueMessages } from "../jobs/message_runner.ts";
import { FakeAdapter } from "../integrations/fake_channel.ts";

const D = new Date("2026-07-01T00:00:00.000Z"); // a diary start instant
const MIN = 60_000;

interface Env {
  db: Awaited<ReturnType<typeof getTestDb>>;
  member: Member;
  study: Study;
  participant: Participant;
  enrollment: Enrollment;
  instrument: Instrument;
}

const LIKERT: FormItem[] = [{
  key: "mood",
  type: "likert",
  prompt: "How is your mood?",
  min: 1,
  max: 5,
  minLabel: "",
  maxLabel: "",
  required: true,
}];

async function withEnv(
  fn: (env: Env) => Promise<void>,
  opts: { doNotContact?: boolean } = {},
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [member] = await db
    .insert(members)
    .values([fakeMember({ email: `diary-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `diary-${suffix}`,
    createdBy: member,
  });
  const study = await createStudy(db, {
    project,
    name: "Diary Study",
    methodology: "diary_study",
    createdBy: member,
  });
  const participant = await createParticipant(db, {
    name: "Ada Diary",
    createdBy: member,
    channels: [{ kind: "email", value: "ada@example.com" }],
  });
  if (opts.doNotContact) {
    await db.update(participants).set({ doNotContact: true }).where(
      eq(participants.id, participant.id),
    );
  }
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: member,
  });
  const instrument = await createInstrument(db, {
    name: "Mood check",
    kind: "simple_form",
    purpose: "diary",
    content: { items: LIKERT },
    createdBy: member,
  });
  await configureDiary(db, {
    study,
    instrument,
    windowType: "fixed",
    config: { times: ["00:00", "12:00"] },
    durationDays: 1,
    expiryMinutes: 120,
    actor: member,
  });
  try {
    await fn({ db, member, study, participant, enrollment, instrument });
  } finally {
    await db.delete(messages).where(eq(messages.enrollmentId, enrollment.id));
    await db.delete(projects).where(eq(projects.createdBy, member.id));
    await db.delete(participants).where(eq(participants.createdBy, member.id));
    await db.delete(instruments).where(eq(instruments.createdBy, member.id));
    await db.delete(members).where(inArray(members.id, [member.id]));
    await closeTestDb();
  }
}

function listPrompts(db: Env["db"], enrollmentId: string) {
  return db
    .select()
    .from(diaryPrompts)
    .where(eq(diaryPrompts.enrollmentId, enrollmentId))
    .orderBy(asc(diaryPrompts.promptAt));
}

Deno.test("configureDiary: one schedule per study", async () => {
  await withEnv(async ({ db, study }) => {
    const schedule = await getDiarySchedule(db, study.id);
    assert.ok(schedule);
    assert.equal(schedule.windowType, "fixed");
    assert.equal(schedule.durationDays, 1);
    assert.equal(schedule.instrumentVersionNumber, 1);
  });
});

Deno.test("generatePrompts: expands the schedule, idempotent per enrollment", async () => {
  await withEnv(async ({ db, study, enrollment }) => {
    const schedule = (await getDiarySchedule(db, study.id))!;
    const first = await generatePrompts(db, {
      schedule,
      enrollment,
      startAt: D,
    });
    assert.equal(first.created, 2); // 00:00 and 12:00 on day 0
    assert.equal(first.skipped, false);

    const second = await generatePrompts(db, {
      schedule,
      enrollment,
      startAt: D,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.created, 0);

    const prompts = await listPrompts(db, enrollment.id);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].promptAt.toISOString(), "2026-07-01T00:00:00.000Z");
    assert.equal(prompts[0].status, "scheduled");
  });
});

Deno.test("sweep: dispatches a due prompt once, then expires the unanswered window", async () => {
  await withEnv(async ({ db, study, enrollment }) => {
    const schedule = (await getDiarySchedule(db, study.id))!;
    await generatePrompts(db, { schedule, enrollment, startAt: D });

    // Just after the first prompt's time → it is dispatched.
    const swept = await sweepDueDiaryPrompts(db, {
      now: new Date(D.getTime() + MIN),
    });
    assert.equal(swept.sent, 1);

    const prompts = await listPrompts(db, enrollment.id);
    assert.equal(prompts[0].status, "sent");
    assert.equal(prompts[1].status, "scheduled"); // 12:00 not yet due

    // A message was enqueued for the prompt, carrying its diary link.
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.enrollmentId, enrollment.id));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].templateKey, "diary_prompt");
    assert.equal(msgs[0].channel, "email");
    assert.equal(msgs[0].idempotencyKey, `diary:${prompts[0].id}`);
    assert.ok(msgs[0].body.includes("/p/"));

    // Re-sweeping the same instant sends nothing more.
    const again = await sweepDueDiaryPrompts(db, {
      now: new Date(D.getTime() + MIN),
    });
    assert.equal(again.sent, 0);

    // Past the first prompt's expiry (120 min) → unanswered window missed.
    const later = await sweepDueDiaryPrompts(db, {
      now: new Date(D.getTime() + 121 * MIN),
    });
    assert.equal(later.missed, 1);
    const after = await listPrompts(db, enrollment.id);
    assert.equal(after[0].status, "missed");
  });
});

Deno.test("sweep: an unreachable participant's due prompt is closed", async () => {
  await withEnv(async ({ db, study, enrollment }) => {
    const schedule = (await getDiarySchedule(db, study.id))!;
    await generatePrompts(db, { schedule, enrollment, startAt: D });
    const swept = await sweepDueDiaryPrompts(db, {
      now: new Date(D.getTime() + MIN),
    });
    assert.equal(swept.sent, 0);
    assert.equal(swept.unreachable, 1);
    const prompts = await listPrompts(db, enrollment.id);
    assert.equal(prompts[0].status, "missed");
  }, { doNotContact: true });
});

Deno.test("submitDiaryEntry: validates, stores, and refuses re-submit / closed", async () => {
  await withEnv(async ({ db, study, enrollment }) => {
    const schedule = (await getDiarySchedule(db, study.id))!;
    await generatePrompts(db, { schedule, enrollment, startAt: D });
    const prompts = await listPrompts(db, enrollment.id);
    const prompt = prompts[0];
    const version = schedule.instrumentVersionNumber;

    // Invalid (out of 1–5 range) → rejected with a field error.
    const bad = await submitDiaryEntry(db, {
      prompt,
      items: LIKERT,
      instrumentVersionNumber: version,
      raw: { mood: "9" },
      now: new Date(D.getTime() + MIN),
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors?.mood);

    // Valid entry → stored, prompt answered.
    const ok = await submitDiaryEntry(db, {
      prompt,
      items: LIKERT,
      instrumentVersionNumber: version,
      raw: { mood: "4" },
      now: new Date(D.getTime() + MIN),
    });
    assert.equal(ok.ok, true);

    const stored = await db
      .select()
      .from(diaryResponses)
      .where(eq(diaryResponses.promptId, prompt.id));
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].answers, { mood: 4 });
    assert.equal((await listPrompts(db, enrollment.id))[0].status, "answered");

    // 4.2: the entry was also captured into the "Responses" dataset,
    // pseudonymously linked and idempotent per prompt.
    const responses = (await listDatasetsOfStudy(db, study.id))
      .find((d) => d.dataset.name === RESPONSES_DATASET);
    assert.ok(responses);
    const captured = await listRecords(db, responses.dataset.id);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].record.data, { mood: 4 });
    assert.equal(captured[0].record.sourceKey, `diary:${prompt.id}`);

    // Re-submit of an answered prompt is a no-op.
    const again = await submitDiaryEntry(db, {
      prompt,
      items: LIKERT,
      instrumentVersionNumber: version,
      raw: { mood: "2" },
      now: new Date(D.getTime() + 2 * MIN),
    });
    assert.equal(again.already, true);

    // Answering a prompt whose window has closed is refused.
    const second = prompts[1];
    await db.update(diaryPrompts).set({ status: "missed" }).where(
      eq(diaryPrompts.id, second.id),
    );
    const closed = await submitDiaryEntry(db, {
      prompt: { ...second, status: "missed" },
      items: LIKERT,
      instrumentVersionNumber: version,
      raw: { mood: "3" },
      now: new Date(D.getTime() + 12 * 60 * MIN + MIN),
    });
    assert.equal(closed.closed, true);
  });
});

Deno.test("generatePromptsForActive + progress + end-to-end delivery", async () => {
  await withEnv(async ({ db, study, enrollment }) => {
    const schedule = (await getDiarySchedule(db, study.id))!;
    // Only active enrollments get prompts from the bulk generator.
    await db.update(enrollments).set({ status: "active" }).where(
      eq(enrollments.id, enrollment.id),
    );

    const gen = await generatePromptsForActive(db, { schedule, startAt: D });
    assert.equal(gen.enrollments, 1);
    assert.equal(gen.prompts, 2);

    // Dispatch the first prompt and deliver it through a fake adapter.
    await sweepDueDiaryPrompts(db, { now: new Date(D.getTime() + MIN) });
    const adapter = new FakeAdapter("email");
    const summary = await runDueMessages(db, { adapter });
    assert.equal(summary.delivered, 1);
    assert.ok(adapter.sent[0].body.includes("diary"));

    const progress = await diaryProgress(db, study.id);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].total, 2);
    assert.equal(progress[0].answered, 0);
    // One sent (awaiting answer) + one still scheduled = 2 pending.
    assert.equal(progress[0].pending, 2);
  });
});
