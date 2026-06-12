// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import {
  createStudy,
  duplicateStudy,
  StudyError,
  transitionStudy,
} from "./studies.ts";
import {
  addCondition,
  type DesignFields,
  listConditions,
  parseTargetN,
  removeCondition,
  updateDesign,
} from "./design.ts";
import { grantApprovedConsent } from "./testing.ts";

const EMPTY_DESIGN: DesignFields = {
  researchQuestions: "",
  hypotheses: "",
  independentVariables: "",
  dependentVariables: "",
  designType: null,
  targetN: null,
  exclusionCriteria: "",
  counterbalancingScheme: "",
  assignmentStrategy: "random_balanced",
  assignmentSequence: "",
};

async function withStudy(
  fn: (
    env: {
      researcher: Member;
      pi: Member;
      study: Study;
      project: Project;
    },
  ) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher, pi] = await db
    .insert(members)
    .values([
      fakeMember({
        email: `design-${suffix}@studyhub.local`,
        role: "researcher",
      }),
      fakeMember({ email: `design-pi-${suffix}@studyhub.local`, role: "pi" }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `design-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Design target",
    methodology: "lab_experiment",
    createdBy: researcher,
  });
  try {
    await fn({ researcher, pi, study, project });
  } finally {
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.delete(members).where(inArray(members.id, [researcher.id, pi.id]));
    await closeTestDb();
  }
}

Deno.test("parseTargetN: empty → null, positive ints ok, junk rejected", () => {
  assert.equal(parseTargetN(""), null);
  assert.equal(parseTargetN(" 24 "), 24);
  assert.throws(() => parseTargetN("0"), StudyError);
  assert.throws(() => parseTargetN("-3"), StudyError);
  assert.throws(() => parseTargetN("12.5"), StudyError);
  assert.throws(() => parseTargetN("many"), StudyError);
});

Deno.test("updateDesign: saves fields, audited, gated by lifecycle", async () => {
  await withStudy(async ({ researcher, pi, study, project }) => {
    const db = await getTestDb();
    const updated = await updateDesign(db, {
      study,
      fields: {
        ...EMPTY_DESIGN,
        researchQuestions: "RQ1: does X?\nRQ2: does Y?",
        hypotheses: "H1: X improves Z",
        independentVariables: "interface variant",
        dependentVariables: "task time\nerror rate",
        designType: "between",
        targetN: 24,
        exclusionCriteria: "incomplete sessions",
        counterbalancingScheme: "ABBA",
      },
      actor: researcher,
    });
    assert.equal(updated.targetN, 24);
    assert.equal(updated.designType, "between");
    assert.ok(updated.researchQuestions.includes("RQ2"));

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, study.id));
    assert.ok(entries.some((e) => e.action === "study.design_updated"));

    // Past irb_review the design is locked.
    await grantApprovedConsent(db, {
      project,
      study: updated,
      author: researcher,
      pi,
    });
    let locked = await transitionStudy(db, {
      study: updated,
      to: "irb_review",
      actor: researcher,
    });
    locked = await transitionStudy(db, {
      study: locked,
      to: "recruiting",
      actor: researcher,
    });
    await assert.rejects(
      () =>
        updateDesign(db, {
          study: locked,
          fields: EMPTY_DESIGN,
          actor: researcher,
        }),
      StudyError,
    );
  });
});

Deno.test("conditions: ordered add, duplicate-name refusal, remove", async () => {
  await withStudy(async ({ researcher, study }) => {
    const db = await getTestDb();
    const a = await addCondition(db, {
      study,
      name: "control",
      actor: researcher,
    });
    const b = await addCondition(db, {
      study,
      name: "treatment",
      actor: researcher,
    });
    assert.equal(a.position, 1);
    assert.equal(b.position, 2);

    await assert.rejects(
      () => addCondition(db, { study, name: " control ", actor: researcher }),
      StudyError,
    );
    await assert.rejects(
      () => addCondition(db, { study, name: "  ", actor: researcher }),
      StudyError,
    );

    await removeCondition(db, {
      study,
      conditionId: a.id,
      actor: researcher,
    });
    const remaining = await listConditions(db, study.id);
    assert.deepEqual(remaining.map((c) => c.name), ["treatment"]);
  });
});

Deno.test("assignment config: manual sequence validated at save, copied on duplicate", async () => {
  await withStudy(async ({ researcher, study }) => {
    const db = await getTestDb();
    await addCondition(db, { study, name: "A", actor: researcher });
    await addCondition(db, { study, name: "B", actor: researcher });

    // Sequence referencing a non-condition is refused.
    await assert.rejects(
      () =>
        updateDesign(db, {
          study,
          fields: {
            ...EMPTY_DESIGN,
            assignmentStrategy: "manual_sequence",
            assignmentSequence: "A, ghost",
          },
          actor: researcher,
        }),
      StudyError,
    );

    const updated = await updateDesign(db, {
      study,
      fields: {
        ...EMPTY_DESIGN,
        assignmentStrategy: "manual_sequence",
        assignmentSequence: "A, B, B, A",
      },
      actor: researcher,
    });
    assert.equal(updated.assignmentStrategy, "manual_sequence");

    const copy = await duplicateStudy(db, {
      study: updated,
      actor: researcher,
    });
    assert.equal(copy.assignmentStrategy, "manual_sequence");
    assert.equal(copy.assignmentSequence, "A, B, B, A");
  });
});

Deno.test("duplicate copies design fields and conditions", async () => {
  await withStudy(async ({ researcher, study }) => {
    const db = await getTestDb();
    const designed = await updateDesign(db, {
      study,
      fields: {
        ...EMPTY_DESIGN,
        researchQuestions: "RQ: carried over?",
        designType: "within",
        targetN: 12,
      },
      actor: researcher,
    });
    await addCondition(db, { study: designed, name: "A", actor: researcher });
    await addCondition(db, { study: designed, name: "B", actor: researcher });

    const copy = await duplicateStudy(db, {
      study: designed,
      actor: researcher,
    });
    assert.equal(copy.researchQuestions, "RQ: carried over?");
    assert.equal(copy.designType, "within");
    assert.equal(copy.targetN, 12);
    const copiedConditions = await listConditions(db, copy.id);
    assert.deepEqual(copiedConditions.map((c) => c.name), ["A", "B"]);
  });
});
