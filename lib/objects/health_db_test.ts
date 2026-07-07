// Integration test — requires the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  members,
  milestones,
  participants,
  projects,
  studies,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment, transitionEnrollment } from "./enrollments.ts";
import { bookSession, publishSlot } from "./sessions.ts";
import { healthSnapshot } from "./health.ts";

Deno.test("healthSnapshot: progress vs target, week's sessions, overdue milestones", async () => {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [member] = await db
    .insert(members)
    .values([fakeMember({ email: `health-${suffix}@studyhub.local` })])
    .returning();
  try {
    const project = await createProject(db, {
      name: `health-${suffix}`,
      createdBy: member,
    });
    const study = await createStudy(db, {
      project,
      name: "Health Study",
      methodology: "survey",
      createdBy: member,
    });
    // Live with a target of 5; drafts must not appear.
    await db
      .update(studies)
      .set({ status: "running", targetN: 5 })
      .where(eq(studies.id, study.id));
    const live = { ...study, status: "running" as const };
    await createStudy(db, {
      project,
      name: "Draft Study",
      methodology: "survey",
      createdBy: member,
    });

    // One consented enrollment counts toward the funnel.
    const participant = await createParticipant(db, {
      name: "Ada Health",
      createdBy: member,
    });
    let enrollment = await createEnrollment(db, {
      study: live,
      participant,
      actor: member,
    });
    for (const to of ["eligible", "consented"] as const) {
      enrollment = await transitionEnrollment(db, {
        enrollment,
        to,
        actor: member,
      });
    }

    // A booked session tomorrow, and one far out (must not appear).
    const tomorrow = await publishSlot(db, {
      study: live,
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      location: "Lab 1",
      actor: member,
    });
    await bookSession(db, { session: tomorrow, enrollment, actor: member });
    await publishSlot(db, {
      study: live,
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      endsAt: new Date(Date.now() + 30 * 86_400_000 + 3600_000),
      actor: member,
    });

    // One overdue milestone, one done-overdue (must not appear).
    await db.insert(milestones).values([
      {
        projectId: project.id,
        studyId: live.id,
        title: "Ethics renewal",
        dueOn: new Date("2020-01-02"),
        status: "pending",
        createdBy: member.id,
      },
      {
        projectId: project.id,
        studyId: live.id,
        title: "Old but done",
        dueOn: new Date("2020-01-01"),
        status: "done",
        createdBy: member.id,
      },
    ]);

    const health = await healthSnapshot(db, member);

    const progress = health.progress.find((p) => p.studyId === live.id);
    assert.ok(progress);
    assert.equal(progress.enrolled, 1);
    assert.equal(progress.target, 5);
    assert.ok(!health.progress.some((p) => p.studyName === "Draft Study"));

    const upcoming = health.upcoming.filter((s) => s.studyId === live.id);
    assert.equal(upcoming.length, 1);
    assert.equal(upcoming[0].participantCode, participant.code);
    assert.equal(upcoming[0].location, "Lab 1");

    const overdue = health.overdue.filter((m) => m.studyId === live.id);
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].title, "Ethics renewal");
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, member.id));
    await db.delete(participants).where(eq(participants.createdBy, member.id));
    await db.delete(members).where(inArray(members.id, [member.id]));
    await closeTestDb();
  }
});
