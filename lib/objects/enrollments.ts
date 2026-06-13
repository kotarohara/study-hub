// Enrollment lifecycle (spec §2.1): screened → eligible → consented →
// active → completed, with withdrawn/excluded exits. Withdrawal is the
// compliance-critical path (spec §4 kept-feature 6) — every transition is
// audited with the pseudonymous code. Pilot enrollments (dry-runs inside a
// real study) share the `pilot` flag with Internal Pilot studies so
// nothing pilot ever leaks into datasets, quotas or exports.
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  conditions,
  type Enrollment,
  enrollments,
  type Member,
  type Participant,
  participants,
  studies,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { errorChainIncludes } from "../db/errors.ts";
import { nextCondition } from "./assignment.ts";
import { listConditions } from "./design.ts";
import { type AuditCtx, isPilotStudy } from "./studies.ts";

export class EnrollmentError extends Error {}

export type EnrollmentStatus = Enrollment["status"];

const TRANSITIONS: Record<EnrollmentStatus, EnrollmentStatus[]> = {
  screened: ["eligible", "excluded"],
  eligible: ["consented", "withdrawn", "excluded"],
  consented: ["active", "withdrawn", "excluded"],
  active: ["completed", "withdrawn", "excluded"],
  completed: [],
  withdrawn: [],
  excluded: [],
};

export function allowedEnrollmentTransitions(
  status: EnrollmentStatus,
): EnrollmentStatus[] {
  return TRANSITIONS[status];
}

export function isTerminal(status: EnrollmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Manual enrollment from the pool (the only way into pilot studies). */
export async function createEnrollment(
  db: Db,
  opts: {
    study: Study;
    participant: Participant;
    isPilot?: boolean;
    actor: Member;
  } & AuditCtx,
): Promise<Enrollment> {
  if (opts.participant.doNotContact) {
    throw new EnrollmentError(
      `${opts.participant.code} is flagged do-not-contact. Clear the flag first if this is intentional.`,
    );
  }
  // Spec §4 kept-feature 5: everything inside an Internal Pilot study is
  // pilot data, no exceptions.
  const isPilot = isPilotStudy(opts.study) || (opts.isPilot ?? false);

  try {
    return await db.transaction(async (tx) => {
      const [enrollment] = await tx
        .insert(enrollments)
        .values({
          studyId: opts.study.id,
          participantId: opts.participant.id,
          status: "screened",
          isPilot,
        })
        .returning();
      await audit(tx, {
        action: "enrollment.created",
        actorId: opts.actor.id,
        objectType: "enrollment",
        objectId: enrollment.id,
        details: {
          code: opts.participant.code,
          studyId: opts.study.id,
          isPilot,
        },
        requestId: opts.requestId,
        ip: opts.ip,
      });
      return enrollment;
    });
  } catch (err) {
    if (errorChainIncludes(err, "enrollments_study_participant_unique")) {
      throw new EnrollmentError(
        `${opts.participant.code} is already enrolled in this study.`,
      );
    }
    throw err;
  }
}

export async function transitionEnrollment(
  db: Db,
  opts:
    & { enrollment: Enrollment; to: EnrollmentStatus; actor: Member }
    & AuditCtx,
): Promise<Enrollment> {
  const from = opts.enrollment.status;
  if (!TRANSITIONS[from].includes(opts.to)) {
    throw new EnrollmentError(`An enrollment cannot go ${from} → ${opts.to}.`);
  }
  const code = await participantCode(db, opts.enrollment.participantId);

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(enrollments)
      .set({ status: opts.to, updatedAt: new Date() })
      .where(eq(enrollments.id, opts.enrollment.id))
      .returning();
    // Withdrawals/exclusions must never go unrecorded: audit inside the
    // transaction so a failed write fails the transition.
    await audit(tx, {
      action: "enrollment.status_changed",
      actorId: opts.actor.id,
      objectType: "enrollment",
      objectId: opts.enrollment.id,
      details: { code, from, to: opts.to },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return updated;
  });
}

/** Pilot flag toggle for dry-run enrollments inside a real study. */
export async function setEnrollmentPilot(
  db: Db,
  opts: {
    study: Study;
    enrollment: Enrollment;
    isPilot: boolean;
    actor: Member;
  } & AuditCtx,
): Promise<Enrollment> {
  if (isPilotStudy(opts.study) && !opts.isPilot) {
    throw new EnrollmentError(
      "Enrollments in an Internal Pilot study are always pilot data.",
    );
  }
  if (isTerminal(opts.enrollment.status)) {
    throw new EnrollmentError(
      "The pilot flag of a finished enrollment cannot change — datasets may already reference it.",
    );
  }
  const code = await participantCode(db, opts.enrollment.participantId);
  const [updated] = await db
    .update(enrollments)
    .set({ isPilot: opts.isPilot, updatedAt: new Date() })
    .where(eq(enrollments.id, opts.enrollment.id))
    .returning();
  await audit(db, {
    action: "enrollment.pilot_changed",
    actorId: opts.actor.id,
    objectType: "enrollment",
    objectId: opts.enrollment.id,
    details: { code, isPilot: opts.isPilot },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

/**
 * Wires the assignment engine (spec §3.2) to a real enrollment: random
 * balanced or manual counterbalanced sequence, per the study's design.
 * Pilot enrollments are excluded from balancing counts and the sequence
 * cursor — quarantined data must not skew real group sizes.
 */
export async function assignCondition(
  db: Db,
  opts: {
    study: Study;
    enrollment: Enrollment;
    actor: Member;
    /** Injectable RNG for tests. */
    random?: () => number;
  } & AuditCtx,
): Promise<Enrollment> {
  if (!["consented", "active"].includes(opts.enrollment.status)) {
    throw new EnrollmentError(
      "Conditions are assigned after consent (consented/active enrollments).",
    );
  }
  if (opts.enrollment.conditionId) {
    throw new EnrollmentError("This enrollment already has a condition.");
  }
  const studyConditions = await listConditions(db, opts.study.id);
  const assigned = await db
    .select({ conditionId: enrollments.conditionId, n: count() })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.studyId, opts.study.id),
        isNotNull(enrollments.conditionId),
        eq(enrollments.isPilot, opts.enrollment.isPilot),
      ),
    )
    .groupBy(enrollments.conditionId);
  const counts: Record<string, number> = {};
  let assignedSoFar = 0;
  for (const row of assigned) {
    if (!row.conditionId) continue;
    counts[row.conditionId] = Number(row.n);
    assignedSoFar += Number(row.n);
  }

  const condition = nextCondition({
    conditions: studyConditions,
    counts,
    strategy: opts.study.assignmentStrategy,
    sequence: opts.study.assignmentSequence,
    assignedSoFar,
    random: opts.random,
  });
  const code = await participantCode(db, opts.enrollment.participantId);

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(enrollments)
      .set({ conditionId: condition.id, updatedAt: new Date() })
      .where(eq(enrollments.id, opts.enrollment.id))
      .returning();
    // Spec §3.2: assignment carries an audit trail, one event per
    // assignment, inside the same transaction.
    await audit(tx, {
      action: "enrollment.condition_assigned",
      actorId: opts.actor.id,
      objectType: "enrollment",
      objectId: opts.enrollment.id,
      details: {
        code,
        condition: condition.name,
        strategy: opts.study.assignmentStrategy,
      },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return updated;
  });
}

async function participantCode(
  db: Db,
  participantId: string,
): Promise<string> {
  const [row] = await db
    .select({ code: participants.code })
    .from(participants)
    .where(eq(participants.id, participantId));
  return row?.code ?? "?";
}

export async function getEnrollment(
  db: Db,
  enrollmentId: string,
): Promise<Enrollment | null> {
  const enrollment = await db.query.enrollments.findFirst({
    where: eq(enrollments.id, enrollmentId),
  });
  return enrollment ?? null;
}

export interface EnrollmentRow {
  enrollment: Enrollment;
  participantCode: string;
  conditionName: string | null;
}

export async function listEnrollmentsOfStudy(
  db: Db,
  studyId: string,
): Promise<EnrollmentRow[]> {
  const rows = await db
    .select({
      enrollment: enrollments,
      participantCode: participants.code,
      conditionName: conditions.name,
    })
    .from(enrollments)
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .leftJoin(conditions, eq(enrollments.conditionId, conditions.id))
    .where(eq(enrollments.studyId, studyId))
    .orderBy(asc(enrollments.createdAt));
  return rows;
}

export interface ParticipationRow {
  enrollment: Enrollment;
  studyName: string;
  studyId: string;
}

/** Participation history for the participant detail page (spec §3.4). */
export async function listEnrollmentsOfParticipant(
  db: Db,
  participantId: string,
): Promise<ParticipationRow[]> {
  const rows = await db
    .select({
      enrollment: enrollments,
      studyName: studies.name,
      studyId: studies.id,
    })
    .from(enrollments)
    .innerJoin(studies, eq(enrollments.studyId, studies.id))
    .where(eq(enrollments.participantId, participantId))
    .orderBy(asc(enrollments.createdAt));
  return rows;
}
