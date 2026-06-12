// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  type Participant,
  participants,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy, setOversightPathway } from "./studies.ts";
import { addCondition } from "./design.ts";
import { createParticipant, setDoNotContact } from "./participants.ts";
import { seededRandom } from "./assignment.ts";
import {
  assignCondition,
  createEnrollment,
  EnrollmentError,
  listEnrollmentsOfParticipant,
  listEnrollmentsOfStudy,
  setEnrollmentPilot,
  transitionEnrollment,
} from "./enrollments.ts";

async function withEnv(
  fn: (env: {
    pi: Member;
    researcher: Member;
    project: Project;
    study: Study;
    alice: Participant;
    bob: Participant;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher] = await db
    .insert(members)
    .values([
      fakeMember({ email: `enr-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({ email: `enr-res-${suffix}@studyhub.local` }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `enr-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Enrollment host study",
    methodology: "lab_experiment",
    createdBy: researcher,
  });
  const alice = await createParticipant(db, {
    name: "Alice Enroll",
    createdBy: researcher,
  });
  const bob = await createParticipant(db, {
    name: "Bob Enroll",
    createdBy: researcher,
  });
  try {
    await fn({ pi, researcher, project, study, alice, bob });
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db
      .delete(members)
      .where(inArray(members.id, [pi.id, researcher.id]));
    await closeTestDb();
  }
}

Deno.test("create: dedup per study, DNC blocked, pilot rules, audited", async () => {
  await withEnv(async ({ pi, researcher, project, study, alice, bob }) => {
    const db = await getTestDb();

    const enrollment = await createEnrollment(db, {
      study,
      participant: alice,
      actor: researcher,
    });
    assert.equal(enrollment.status, "screened");
    assert.equal(enrollment.isPilot, false);

    // One enrollment per participant per study.
    await assert.rejects(
      () =>
        createEnrollment(db, { study, participant: alice, actor: researcher }),
      /already enrolled/,
    );

    // Do-not-contact blocks manual enrollment.
    await setDoNotContact(db, {
      participant: bob,
      doNotContact: true,
      actor: researcher,
    });
    await assert.rejects(
      () =>
        createEnrollment(db, {
          study,
          participant: { ...bob, doNotContact: true },
          actor: researcher,
        }),
      /do-not-contact/,
    );

    // Everything in an Internal Pilot study is pilot data, forced.
    const pilotStudy = await setOversightPathway(db, {
      study: await createStudy(db, {
        project,
        name: "Pilot",
        methodology: "survey",
        createdBy: researcher,
      }),
      input: { pathway: "internal_pilot", justification: "dry run" },
      actor: pi,
    });
    const pilotEnrollment = await createEnrollment(db, {
      study: pilotStudy,
      participant: alice,
      isPilot: false, // ignored: the study is a pilot
      actor: researcher,
    });
    assert.equal(pilotEnrollment.isPilot, true);
    await assert.rejects(
      () =>
        setEnrollmentPilot(db, {
          study: pilotStudy,
          enrollment: pilotEnrollment,
          isPilot: false,
          actor: researcher,
        }),
      /always pilot/,
    );

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, enrollment.id));
    assert.equal(entry.action, "enrollment.created");
    assert.equal(entry.details?.code, alice.code);
    assert.ok(!JSON.stringify(entry.details).includes("Alice"));
  });
});

Deno.test("lifecycle: legal path only, terminal states stay terminal", async () => {
  await withEnv(async ({ researcher, study, alice }) => {
    const db = await getTestDb();
    let enrollment = await createEnrollment(db, {
      study,
      participant: alice,
      actor: researcher,
    });

    // Cannot skip ahead.
    await assert.rejects(
      () =>
        transitionEnrollment(db, {
          enrollment,
          to: "active",
          actor: researcher,
        }),
      EnrollmentError,
    );

    for (
      const to of ["eligible", "consented", "active", "completed"] as const
    ) {
      enrollment = await transitionEnrollment(db, {
        enrollment,
        to,
        actor: researcher,
      });
    }
    assert.equal(enrollment.status, "completed");
    await assert.rejects(
      () =>
        transitionEnrollment(db, {
          enrollment,
          to: "withdrawn",
          actor: researcher,
        }),
      EnrollmentError,
    );
    // Pilot flag is frozen once terminal.
    await assert.rejects(
      () =>
        setEnrollmentPilot(db, {
          study,
          enrollment,
          isPilot: true,
          actor: researcher,
        }),
      /finished enrollment/,
    );

    // Every step audited with the pseudonymous code.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, enrollment.id));
    const steps = entries
      .filter((e) => e.action === "enrollment.status_changed")
      .map((e) => e.details?.to);
    assert.deepEqual(steps, ["eligible", "consented", "active", "completed"]);
    for (const e of entries) {
      assert.ok(!JSON.stringify(e.details).includes("Alice"));
    }
  });
});

Deno.test("assignment: balanced, pilot-segregated, once per enrollment, audited", async () => {
  await withEnv(async ({ researcher, study, alice, bob }) => {
    const db = await getTestDb();
    await addCondition(db, { study, name: "A", actor: researcher });
    await addCondition(db, { study, name: "B", actor: researcher });
    const random = seededRandom(42);

    async function consentedEnrollment(
      participant: Participant,
      isPilot = false,
    ) {
      let e = await createEnrollment(db, {
        study,
        participant,
        isPilot,
        actor: researcher,
      });
      e = await transitionEnrollment(db, {
        enrollment: e,
        to: "eligible",
        actor: researcher,
      });
      return await transitionEnrollment(db, {
        enrollment: e,
        to: "consented",
        actor: researcher,
      });
    }

    // Assignment requires consent.
    const fresh = await createEnrollment(db, {
      study,
      participant: alice,
      actor: researcher,
    });
    await assert.rejects(
      () =>
        assignCondition(db, {
          study,
          enrollment: fresh,
          actor: researcher,
          random,
        }),
      /after consent/,
    );
    let aliceEnr = await transitionEnrollment(db, {
      enrollment: fresh,
      to: "eligible",
      actor: researcher,
    });
    aliceEnr = await transitionEnrollment(db, {
      enrollment: aliceEnr,
      to: "consented",
      actor: researcher,
    });
    const bobEnr = await consentedEnrollment(bob);

    // Two real enrollments → balanced across A and B.
    const assigned1 = await assignCondition(db, {
      study,
      enrollment: aliceEnr,
      actor: researcher,
      random,
    });
    const assigned2 = await assignCondition(db, {
      study,
      enrollment: bobEnr,
      actor: researcher,
      random,
    });
    assert.notEqual(assigned1.conditionId, assigned2.conditionId);

    // No reassignment.
    await assert.rejects(
      () =>
        assignCondition(db, {
          study,
          enrollment: assigned1,
          actor: researcher,
          random,
        }),
      /already has a condition/,
    );

    // Pilot enrollments balance separately from real ones.
    const carol = await createParticipant(db, {
      name: "Carol Enroll",
      createdBy: researcher,
    });
    const pilotEnr = await consentedEnrollment(carol, true);
    const assignedPilot = await assignCondition(db, {
      study,
      enrollment: pilotEnr,
      actor: researcher,
      random,
    });
    assert.ok(assignedPilot.conditionId);

    const rows = await listEnrollmentsOfStudy(db, study.id);
    assert.equal(rows.length, 3);
    assert.ok(
      rows.every((r) => r.conditionName === "A" || r.conditionName === "B"),
    );

    const history = await listEnrollmentsOfParticipant(db, alice.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].studyName, study.name);

    // Per-assignment audit events (spec §3.2).
    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "enrollment.condition_assigned"));
    const ours = events.filter((e) =>
      [assigned1.id, assigned2.id, assignedPilot.id].includes(e.objectId ?? "")
    );
    assert.equal(ours.length, 3);
    assert.ok(ours.every((e) => e.details?.strategy === "random_balanced"));
  });
});
