// Compensation domain logic (spec §2.1, §3.9). Lifecycle pending →
// approved → paid, with approvals and payouts audited (spec §4: "payment
// approvals"). Everything read here is pseudonymous — code, study,
// amount; names/phones appear only in the PI-gated ledger export (4.8).
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Compensation,
  type CompensationMethod,
  compensations,
  type CompensationStatus,
  type Enrollment,
  enrollments,
  type Member,
  participants,
  studies,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { notifyPaymentSent } from "./notifications.ts";
import type { AuditCtx } from "./studies.ts";

export class CompensationError extends Error {}

export const COMPENSATION_METHODS: CompensationMethod[] = [
  "paynow",
  "paypal",
  "prolific",
  "cash",
  "voucher",
];

/** Legal lifecycle moves; paid is terminal. */
const TRANSITIONS: Record<CompensationStatus, CompensationStatus[]> = {
  pending: ["approved"],
  approved: ["paid"],
  paid: [],
};

export async function createCompensation(
  db: Db,
  opts: {
    enrollment: Enrollment;
    amountCents: number;
    method: CompensationMethod;
    scheme?: string;
    notes?: string;
    /** Prolific submission id, for method "prolific" (spec §3.9). */
    prolificSubmissionId?: string;
    createdBy: Member;
  } & AuditCtx,
): Promise<Compensation> {
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) {
    throw new CompensationError("Amount must be a positive number of cents.");
  }
  const [compensation] = await db
    .insert(compensations)
    .values({
      enrollmentId: opts.enrollment.id,
      amountCents: opts.amountCents,
      method: opts.method,
      scheme: opts.scheme?.trim() ?? "",
      prolificSubmissionId: opts.prolificSubmissionId?.trim() ?? "",
      notes: opts.notes?.trim() ?? "",
      createdBy: opts.createdBy.id,
    })
    .returning();
  await audit(db, {
    action: "compensation.created",
    actorId: opts.createdBy.id,
    objectType: "compensation",
    objectId: compensation.id,
    details: {
      enrollmentId: opts.enrollment.id,
      amountCents: opts.amountCents,
      method: opts.method,
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return compensation;
}

export async function getCompensation(
  db: Db,
  compensationId: string,
): Promise<Compensation | null> {
  const row = await db.query.compensations.findFirst({
    where: eq(compensations.id, compensationId),
  });
  return row ?? null;
}

function assertTransition(
  from: CompensationStatus,
  to: CompensationStatus,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new CompensationError(
      `A ${from} compensation cannot become ${to}.`,
    );
  }
}

/** Approves a pending compensation (researcher+ enforced by routes);
 * audited — approval is the act that authorizes money to move. */
export async function approveCompensation(
  db: Db,
  opts: { compensation: Compensation; actor: Member } & AuditCtx,
): Promise<Compensation> {
  assertTransition(opts.compensation.status, "approved");
  const [updated] = await db
    .update(compensations)
    .set({
      status: "approved",
      approvedBy: opts.actor.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(compensations.id, opts.compensation.id),
        eq(compensations.status, "pending"),
      ),
    )
    .returning();
  if (!updated) {
    throw new CompensationError("This compensation was already processed.");
  }
  await audit(db, {
    action: "payment.approve",
    actorId: opts.actor.id,
    objectType: "compensation",
    objectId: updated.id,
    details: { amountCents: updated.amountCents, method: updated.method },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

/** Fires the participant-facing confirmation for one paid compensation.
 * Idempotent and skip-tolerant (do-not-contact, no channel). */
async function confirmPayment(
  db: Db,
  paid: Compensation,
): Promise<void> {
  const [row] = await db
    .select({ studyId: enrollments.studyId })
    .from(enrollments)
    .where(eq(enrollments.id, paid.enrollmentId));
  if (!row) return;
  await notifyPaymentSent(db, {
    compensationId: paid.id,
    enrollmentId: paid.enrollmentId,
    studyId: row.studyId,
    amountLabel: fmtAmount(paid.amountCents, paid.currency),
  });
}

/** Marks an approved compensation paid (after the manual PayNow/PayPal
 * transfer happens outside StudyHub), recording the transfer reference.
 * Audited; the participant gets a payment confirmation (spec §3.9). */
export async function markCompensationPaid(
  db: Db,
  opts: {
    compensation: Compensation;
    actor: Member;
    reference?: string;
  } & AuditCtx,
): Promise<Compensation> {
  assertTransition(opts.compensation.status, "paid");
  const [updated] = await db
    .update(compensations)
    .set({
      status: "paid",
      paidBy: opts.actor.id,
      paidAt: new Date(),
      reference: opts.reference?.trim() ?? "",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(compensations.id, opts.compensation.id),
        eq(compensations.status, "approved"),
      ),
    )
    .returning();
  if (!updated) {
    throw new CompensationError("Only an approved compensation can be paid.");
  }
  await audit(db, {
    action: "payment.paid",
    actorId: opts.actor.id,
    objectType: "compensation",
    objectId: updated.id,
    details: {
      amountCents: updated.amountCents,
      method: updated.method,
      reference: updated.reference,
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  await confirmPayment(db, updated);
  return updated;
}

/** A compensation with pseudonymous linkage for lists and the dashboard. */
export interface CompensationRow {
  compensation: Compensation;
  participantCode: string;
  studyId: string;
  studyName: string;
}

const ROW_SELECT = {
  compensation: compensations,
  participantCode: participants.code,
  studyId: studies.id,
  studyName: studies.name,
} as const;

/** Everything not yet paid, lab-wide — the outstanding-payments dashboard
 * (spec §3.9). Oldest first so nothing rots at the bottom. */
export async function listOutstanding(db: Db): Promise<CompensationRow[]> {
  return await db
    .select(ROW_SELECT)
    .from(compensations)
    .innerJoin(enrollments, eq(compensations.enrollmentId, enrollments.id))
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .innerJoin(studies, eq(enrollments.studyId, studies.id))
    .where(ne(compensations.status, "paid"))
    .orderBy(asc(compensations.createdAt));
}

export async function listCompensationsOfStudy(
  db: Db,
  studyId: string,
): Promise<CompensationRow[]> {
  return await db
    .select(ROW_SELECT)
    .from(compensations)
    .innerJoin(enrollments, eq(compensations.enrollmentId, enrollments.id))
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .innerJoin(studies, eq(enrollments.studyId, studies.id))
    .where(eq(enrollments.studyId, studyId))
    .orderBy(asc(compensations.createdAt));
}

export interface OutstandingTotals {
  pendingCount: number;
  pendingCents: number;
  approvedCount: number;
  approvedCents: number;
  /** Approved (payable) cents by method — what each run sheet will carry. */
  approvedByMethod: Record<string, number>;
}

/** Dashboard totals. Pure. */
export function outstandingTotals(
  rows: CompensationRow[],
): OutstandingTotals {
  const totals: OutstandingTotals = {
    pendingCount: 0,
    pendingCents: 0,
    approvedCount: 0,
    approvedCents: 0,
    approvedByMethod: {},
  };
  for (const { compensation } of rows) {
    if (compensation.status === "pending") {
      totals.pendingCount++;
      totals.pendingCents += compensation.amountCents;
    } else if (compensation.status === "approved") {
      totals.approvedCount++;
      totals.approvedCents += compensation.amountCents;
      totals.approvedByMethod[compensation.method] =
        (totals.approvedByMethod[compensation.method] ?? 0) +
        compensation.amountCents;
    }
  }
  return totals;
}

/** "SGD 12.50" — amounts are integer cents everywhere else. */
export function fmtAmount(cents: number, currency = "SGD"): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

/** Batch fetch, preserving pseudonymity, for run sheets (4.7). */
export async function listApprovedByMethod(
  db: Db,
  method: CompensationMethod,
): Promise<CompensationRow[]> {
  return await db
    .select(ROW_SELECT)
    .from(compensations)
    .innerJoin(enrollments, eq(compensations.enrollmentId, enrollments.id))
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .innerJoin(studies, eq(enrollments.studyId, studies.id))
    .where(
      and(
        eq(compensations.status, "approved"),
        eq(compensations.method, method),
      ),
    )
    .orderBy(asc(compensations.createdAt));
}

/** Marks a batch of approved compensations paid with one shared transfer
 * reference (run-sheet flow, 4.7). Only approved rows flip; each payout is
 * audited and each participant gets a confirmation. */
export async function markBatchPaid(
  db: Db,
  opts: { ids: string[]; actor: Member; reference?: string } & AuditCtx,
): Promise<number> {
  if (opts.ids.length === 0) return 0;
  const updated = await db
    .update(compensations)
    .set({
      status: "paid",
      paidBy: opts.actor.id,
      paidAt: new Date(),
      reference: opts.reference?.trim() ?? "",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(compensations.id, opts.ids),
        eq(compensations.status, "approved"),
      ),
    )
    .returning();
  for (const row of updated) {
    await audit(db, {
      action: "payment.paid",
      actorId: opts.actor.id,
      objectType: "compensation",
      objectId: row.id,
      details: {
        amountCents: row.amountCents,
        batch: true,
        reference: row.reference,
      },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    await confirmPayment(db, row);
  }
  return updated.length;
}
