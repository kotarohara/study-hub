// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  type Member,
  members,
  type Participant,
  participants,
  type Project,
  projects,
  studies,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { addCondition } from "./design.ts";
import { createParticipant } from "./participants.ts";
import { createInstrument } from "./instruments.ts";
import { configureScreener, recordScreenerView } from "./screeners.ts";
import {
  assignCondition,
  createEnrollment,
  transitionEnrollment,
} from "./enrollments.ts";
import { seededRandom } from "./assignment.ts";
import { studyFunnel } from "./funnel.ts";

async function withEnv(
  fn: (env: {
    researcher: Member;
    project: Project;
    study: Study;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `fun-res-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `fun-test-${suffix}`,
    createdBy: researcher,
  });
  let study = await createStudy(db, {
    project,
    name: "Funnel host study",
    methodology: "lab_experiment",
    createdBy: researcher,
  });
  // Set the design target directly — updateDesign needs the full field
  // set and the design editor is not under test here.
  [study] = await db
    .update(studies)
    .set({ targetN: 10 })
    .where(eq(studies.id, study.id))
    .returning();
  try {
    await fn({ researcher, project, study });
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    // Instruments are lab-wide, not project-scoped.
    await db.execute(
      sql`delete from instruments where created_by = ${researcher.id}`,
    );
    await db.delete(members).where(inArray(members.id, [researcher.id]));
    await closeTestDb();
  }
}

Deno.test("studyFunnel: stages, sources, quotas; pilots quarantined", async () => {
  await withEnv(async ({ researcher, study }) => {
    const db = await getTestDb();
    await addCondition(db, { study, name: "A", actor: researcher });
    await addCondition(db, { study, name: "B", actor: researcher });

    // Screener with two recorded views feeds the "viewed" stage.
    const instrument = await createInstrument(db, {
      name: "Funnel screener",
      kind: "simple_form",
      purpose: "screener",
      content: {
        items: [{ key: "age", prompt: "Age", type: "number" }],
        scoring: [],
      },
      createdBy: researcher,
    });
    const screener = await configureScreener(db, {
      study,
      instrument,
      eligibility: [],
      actor: researcher,
    });
    await recordScreenerView(db, screener);
    await recordScreenerView(db, screener);

    const random = seededRandom(7);
    async function enroll(
      name: string,
      source: string,
      opts: {
        to?: ("eligible" | "consented" | "active" | "completed")[];
        isPilot?: boolean;
        assign?: boolean;
      } = {},
    ) {
      const participant: Participant = await createParticipant(db, {
        name,
        source,
        createdBy: researcher,
      });
      let enrollment = await createEnrollment(db, {
        study,
        participant,
        isPilot: opts.isPilot,
        actor: researcher,
      });
      for (const to of opts.to ?? []) {
        enrollment = await transitionEnrollment(db, {
          enrollment,
          to,
          actor: researcher,
        });
      }
      if (opts.assign) {
        enrollment = await assignCondition(db, {
          study,
          enrollment,
          actor: researcher,
          random,
        });
      }
      return enrollment;
    }

    await enroll("P1", "flyer"); // screened only
    await enroll("P2", "flyer", { to: ["eligible"] });
    await enroll("P3", "flyer", {
      to: ["eligible", "consented"],
      assign: true,
    });
    await enroll("P4", "class", {
      to: ["eligible", "consented", "active", "completed"],
      assign: false,
    });
    // Pilot dry-run: must not appear anywhere in funnel or quotas.
    await enroll("P5", "flyer", {
      to: ["eligible", "consented"],
      isPilot: true,
      assign: true,
    });

    const funnel = await studyFunnel(db, study);

    assert.deepEqual(
      funnel.stages.map((s) => [s.id, s.count]),
      [
        ["viewed", 2],
        ["screened", 4], // P5 (pilot) excluded
        ["eligible", 3],
        ["consented", 2],
        ["completed", 1],
      ],
    );

    const flyer = funnel.bySource.find((row) => row.source === "flyer");
    assert.ok(flyer);
    assert.equal(flyer.stages.find((s) => s.id === "screened")?.count, 3);
    assert.equal(flyer.stages.find((s) => s.id === "consented")?.count, 1);
    const cls = funnel.bySource.find((row) => row.source === "class");
    assert.equal(cls?.stages.find((s) => s.id === "completed")?.count, 1);

    // Quotas: targetN 10 over 2 conditions → 5 each. P3 assigned, P4
    // consented+ without a condition yet, pilot P5's assignment ignored.
    assert.equal(funnel.overall.target, 10);
    assert.equal(funnel.overall.count, 2);
    const assignedTotal = funnel.quotas
      .filter((quota) => quota.conditionId !== null)
      .reduce((total, quota) => total + quota.count, 0);
    assert.equal(assignedTotal, 1);
    assert.ok(
      funnel.quotas
        .filter((quota) => quota.conditionId !== null)
        .every((quota) => quota.target === 5),
    );
    assert.equal(
      funnel.quotas.find((quota) => quota.conditionId === null)?.count,
      1,
    );

    assert.equal(funnel.pilotCount, 1);
    assert.equal(funnel.screenerStatus, "open");
  });
});
