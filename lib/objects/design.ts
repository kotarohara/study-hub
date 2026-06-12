// Structured design editor logic (spec §3.2, simplified): research
// questions, hypotheses, IVs/DVs, conditions, design type, target N,
// exclusion criteria, and the recorded counterbalancing scheme. Editable
// in the same lifecycle states as the rest of the design; changes after
// IRB review are amendments (Phase 1.7).
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Condition,
  conditions,
  type Member,
  studies,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { errorChainIncludes } from "../db/errors.ts";
import { type AuditCtx, EDITABLE_STATES, StudyError } from "./studies.ts";
import { type AssignmentStrategy, parseSequence } from "./assignment.ts";

export const DESIGN_TYPES = ["between", "within", "mixed"] as const;
export type DesignType = (typeof DESIGN_TYPES)[number];

export interface DesignFields {
  researchQuestions: string;
  hypotheses: string;
  independentVariables: string;
  dependentVariables: string;
  designType: DesignType | null;
  targetN: number | null;
  exclusionCriteria: string;
  counterbalancingScheme: string;
  assignmentStrategy: AssignmentStrategy;
  assignmentSequence: string;
}

function assertEditable(study: Study) {
  if (!EDITABLE_STATES.includes(study.status)) {
    throw new StudyError(
      `The design of a study in "${study.status}" cannot be changed.`,
    );
  }
}

export function parseTargetN(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new StudyError("Target N must be a positive whole number.");
  }
  return n;
}

export async function updateDesign(
  db: Db,
  opts: { study: Study; fields: DesignFields; actor: Member } & AuditCtx,
): Promise<Study> {
  assertEditable(opts.study);
  const f = opts.fields;
  if (f.assignmentStrategy === "manual_sequence") {
    // A manual sequence must reference existing conditions of this study.
    parseSequence(
      f.assignmentSequence,
      await listConditions(db, opts.study.id),
    );
  }
  const [updated] = await db
    .update(studies)
    .set({
      researchQuestions: f.researchQuestions.trim(),
      hypotheses: f.hypotheses.trim(),
      independentVariables: f.independentVariables.trim(),
      dependentVariables: f.dependentVariables.trim(),
      designType: f.designType,
      targetN: f.targetN,
      exclusionCriteria: f.exclusionCriteria.trim(),
      counterbalancingScheme: f.counterbalancingScheme.trim(),
      assignmentStrategy: f.assignmentStrategy,
      assignmentSequence: f.assignmentSequence.trim(),
      updatedAt: new Date(),
    })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.design_updated",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function listConditions(
  db: Db,
  studyId: string,
): Promise<Condition[]> {
  return await db
    .select()
    .from(conditions)
    .where(eq(conditions.studyId, studyId))
    .orderBy(asc(conditions.position));
}

export async function addCondition(
  db: Db,
  opts: { study: Study; name: string; actor: Member } & AuditCtx,
): Promise<Condition> {
  assertEditable(opts.study);
  const name = opts.name.trim();
  if (!name) throw new StudyError("Condition name is required.");

  return await db.transaction(async (tx) => {
    const [{ next }] = await tx
      .select({
        next: sql<number>`coalesce(max(${conditions.position}), 0) + 1`,
      })
      .from(conditions)
      .where(eq(conditions.studyId, opts.study.id));
    let condition: Condition;
    try {
      [condition] = await tx
        .insert(conditions)
        .values({ studyId: opts.study.id, name, position: next })
        .returning();
    } catch (err) {
      if (errorChainIncludes(err, "conditions_study_name_unique")) {
        throw new StudyError(`A condition named "${name}" already exists.`);
      }
      throw err;
    }
    await audit(tx, {
      action: "study.condition_added",
      actorId: opts.actor.id,
      objectType: "study",
      objectId: opts.study.id,
      details: { conditionId: condition.id, name },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return condition;
  });
}

export async function removeCondition(
  db: Db,
  opts: { study: Study; conditionId: string; actor: Member } & AuditCtx,
): Promise<void> {
  assertEditable(opts.study);
  const removed = await db
    .delete(conditions)
    .where(
      and(
        eq(conditions.id, opts.conditionId),
        eq(conditions.studyId, opts.study.id),
      ),
    )
    .returning();
  if (removed.length === 0) return;
  await audit(db, {
    action: "study.condition_removed",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: { conditionId: opts.conditionId, name: removed[0].name },
    requestId: opts.requestId,
    ip: opts.ip,
  });
}
