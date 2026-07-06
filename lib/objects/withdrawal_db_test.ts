// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  contactChannels,
  datasetRecords,
  diaryPrompts,
  type Enrollment,
  enrollments,
  instruments,
  type Member,
  members,
  type Participant,
  participants,
  projects,
  type Study,
  studySessions,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant, listChannels } from "./participants.ts";
import { createEnrollment, transitionEnrollment } from "./enrollments.ts";
import { bookSession, publishSlot } from "./sessions.ts";
import { addRecords, createDataset, listRecords } from "./datasets.ts";
import { createInstrument } from "./instruments.ts";
import { configureDiary } from "./diary.ts";
import {
  purgeCandidates,
  purgeParticipant,
  withdrawEnrollment,
} from "./withdrawal.ts";

interface Env {
  db: Awaited<ReturnType<typeof getTestDb>>;
  member: Member;
  study: Study;
  participant: Participant;
  enrollment: Enrollment;
}

async function withEnv(fn: (env: Env) => Promise<void>) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [member] = await db
    .insert(members)
    .values([fakeMember({ email: `wd-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `wd-${suffix}`,
    createdBy: member,
  });
  const study = await createStudy(db, {
    project,
    name: "Withdraw Study",
    methodology: "diary_study",
    createdBy: member,
  });
  const participant = await createParticipant(db, {
    name: "Ada Leaves",
    createdBy: member,
    channels: [{ kind: "email", value: "ada-leaves@example.com" }],
  });
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: member,
  });
  try {
    await fn({ db, member, study, participant, enrollment });
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, member.id));
    await db.delete(participants).where(eq(participants.createdBy, member.id));
    await db.delete(instruments).where(eq(instruments.createdBy, member.id));
    await db.delete(members).where(inArray(members.id, [member.id]));
    await closeTestDb();
  }
}

/** Move a fresh enrollment to active so withdrawal is a legal move. */
async function activate(env: Env): Promise<Enrollment> {
  let e = env.enrollment;
  for (const to of ["eligible", "consented", "active"] as const) {
    e = await transitionEnrollment(env.db, {
      enrollment: e,
      to,
      actor: env.member,
    });
  }
  return e;
}

Deno.test("withdrawal: cancels obligations; retain keeps data, delete erases it", async () => {
  await withEnv(async (env) => {
    const { db, member, study } = env;
    const active = await activate(env);

    // Collected data + future obligations to act on.
    const dataset = await createDataset(db, {
      study,
      name: "Responses",
      createdBy: member,
    });
    await addRecords(db, {
      dataset,
      rows: [{ enrollmentId: active.id, data: { mood: 4 } }],
    });
    const instrument = await createInstrument(db, {
      name: "Mood",
      kind: "simple_form",
      purpose: "diary",
      content: {
        items: [{
          key: "mood",
          type: "likert",
          prompt: "Mood?",
          min: 1,
          max: 5,
          minLabel: "",
          maxLabel: "",
          required: true,
        }],
      },
      createdBy: member,
    });
    const schedule = await configureDiary(db, {
      study,
      instrument,
      windowType: "fixed",
      config: { times: ["12:00"] },
      durationDays: 1,
      expiryMinutes: 60,
      actor: member,
    });
    await db.insert(diaryPrompts).values({
      scheduleId: schedule.id,
      enrollmentId: active.id,
      studyId: study.id,
      promptAt: new Date(Date.now() + 3600_000),
      expiresAt: new Date(Date.now() + 7200_000),
    });

    const slot = await publishSlot(db, {
      study,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      actor: member,
    });
    await bookSession(db, { session: slot, enrollment: active, actor: member });

    const result = await withdrawEnrollment(db, {
      enrollment: active,
      dataHandling: "retain",
      reason: "moving away",
      actor: member,
    });
    assert.equal(result.enrollment.status, "withdrawn");
    assert.equal(result.cancelledPrompts, 1);
    assert.equal(result.freedSessions, 1);
    assert.equal(result.deletedRecords, 0);

    // The booked slot is open again; the retained record still exists.
    const [freedSlot] = await db
      .select()
      .from(studySessions)
      .where(eq(studySessions.id, slot.id));
    assert.equal(freedSlot.status, "open");
    assert.equal(freedSlot.enrollmentId, null);
    assert.equal((await listRecords(db, dataset.id)).length, 1);

    // Audited with counts, no PII.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, active.id));
    const withdrawal = entries.find(
      (e) => e.action === "enrollment.withdrawal_processed",
    );
    assert.ok(withdrawal);
    assert.equal(withdrawal.details?.dataHandling, "retain");
    assert.ok(!JSON.stringify(entries).includes("Ada Leaves"));
  });
});

Deno.test("withdrawal with delete: collected records are erased", async () => {
  await withEnv(async (env) => {
    const { db, member, study } = env;
    const active = await activate(env);
    const dataset = await createDataset(db, {
      study,
      name: "Responses",
      createdBy: member,
    });
    await addRecords(db, {
      dataset,
      rows: [
        { enrollmentId: active.id, data: { mood: 4 } },
        { enrollmentId: active.id, data: { mood: 2 } },
      ],
    });

    const result = await withdrawEnrollment(db, {
      enrollment: active,
      dataHandling: "delete",
      actor: member,
    });
    assert.equal(result.deletedRecords, 2);
    assert.equal((await listRecords(db, dataset.id)).length, 0);
    assert.equal(
      (await db
        .select()
        .from(datasetRecords)
        .where(eq(datasetRecords.enrollmentId, active.id))).length,
      0,
    );
  });
});

Deno.test("retention + purge: candidates gated by terminal-and-idle; purge erases PII, keeps code", async () => {
  await withEnv(async (env) => {
    const { db, member, participant } = env;

    // Active enrollment → not a candidate, however old.
    await db
      .update(participants)
      .set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(participants.id, participant.id));
    let candidates = await purgeCandidates(db, { retentionDays: 30 });
    assert.ok(!candidates.some((c) => c.participant.id === participant.id));

    // Terminal everywhere + idle → candidate.
    await db
      .update(enrollments)
      .set({ status: "excluded" })
      .where(eq(enrollments.id, env.enrollment.id));
    candidates = await purgeCandidates(db, { retentionDays: 30 });
    const mine = candidates.find((c) => c.participant.id === participant.id);
    assert.ok(mine);
    assert.ok(mine.inactiveDays > 300);

    // Purge: channels gone, PII overwritten, code + enrollment intact.
    const purged = await purgeParticipant(db, {
      participant,
      actor: member,
    });
    assert.equal(purged.channelsDeleted, 1);
    assert.equal((await listChannels(db, participant.id)).length, 0);
    const [after] = await db
      .select()
      .from(participants)
      .where(eq(participants.id, participant.id));
    assert.equal(after.name, "[purged]");
    assert.equal(after.code, participant.code); // pseudonym survives
    assert.equal(after.doNotContact, true);
    const [enrollmentAfter] = await db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, env.enrollment.id));
    assert.ok(enrollmentAfter); // research linkage survives

    // Purged participants never re-appear as candidates.
    candidates = await purgeCandidates(db, { retentionDays: 30 });
    assert.ok(!candidates.some((c) => c.participant.id === participant.id));

    // The purge is audited with the pseudonymous code only.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "participant.purged"));
    assert.ok(entry);
    assert.ok(!JSON.stringify(entry.details).includes("Ada Leaves"));

    // Channels table really has nothing left for this participant.
    assert.equal(
      (await db
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.participantId, participant.id))).length,
      0,
    );
  });
});
