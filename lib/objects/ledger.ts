// Run sheets + reimbursement ledger (spec §3.9, §4). THE ONLY PLACE where
// a compensation amount meets a participant's name or payment address —
// PII-bearing by design, therefore PI-gated at the routes and audited as a
// PII export before any bytes leave. Channel values decrypt transparently
// on read (app-layer encryption).
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type CompensationMethod,
  compensations,
  contactChannels,
  enrollments,
  participants,
  studies,
} from "../db/schema.ts";

/** Which contact channel carries the payment address for a method. */
const PAYMENT_CHANNEL: Partial<
  Record<CompensationMethod, "phone" | "paypal" | "prolific">
> = {
  paynow: "phone",
  paypal: "paypal",
  prolific: "prolific",
};

export interface RunSheetRow {
  compensationId: string;
  /** PII: participant name (decrypted). */
  name: string;
  /** PII: payment address for the method (PayNow phone / PayPal email /
   * Prolific ID); empty when the participant has no such channel. */
  payTo: string;
  amountCents: number;
  currency: string;
  scheme: string;
  studyName: string;
  prolificSubmissionId: string;
}

/**
 * The approved-and-unpaid rows for one payment method, with the details a
 * lab member needs to execute the transfers manually (spec §3.9). Rows
 * missing a payment channel surface with an empty payTo so the gap is
 * visible instead of silently dropped.
 */
export async function runSheet(
  db: Db,
  method: CompensationMethod,
): Promise<RunSheetRow[]> {
  const rows = await db
    .select({
      compensationId: compensations.id,
      name: participants.name,
      participantId: participants.id,
      amountCents: compensations.amountCents,
      currency: compensations.currency,
      scheme: compensations.scheme,
      studyName: studies.name,
      prolificSubmissionId: compensations.prolificSubmissionId,
    })
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

  const channelKind = PAYMENT_CHANNEL[method];
  const payTo = new Map<string, string>();
  if (channelKind && rows.length > 0) {
    const channels = await db
      .select({
        participantId: contactChannels.participantId,
        value: contactChannels.value,
      })
      .from(contactChannels)
      .where(
        and(
          inArray(
            contactChannels.participantId,
            [...new Set(rows.map((r) => r.participantId))],
          ),
          eq(contactChannels.kind, channelKind),
        ),
      );
    for (const channel of channels) {
      if (!payTo.has(channel.participantId)) {
        payTo.set(channel.participantId, channel.value);
      }
    }
  }

  return rows.map((row) => ({
    compensationId: row.compensationId,
    name: row.name,
    payTo: payTo.get(row.participantId) ?? "",
    amountCents: row.amountCents,
    currency: row.currency,
    scheme: row.scheme,
    studyName: row.studyName,
    prolificSubmissionId: row.prolificSubmissionId,
  }));
}

export interface LedgerRow {
  /** PII: Name, Phone (spec-fixed ledger columns). */
  name: string;
  phone: string;
  amountCents: number;
  currency: string;
  method: string;
  paidAt: Date | null;
  reference: string;
}

/** The reimbursement ledger (spec §3.9): every PAID compensation with the
 * spec-fixed columns Name / Phone Number / Amount (+ date, reference). */
export async function ledgerRows(db: Db): Promise<LedgerRow[]> {
  const rows = await db
    .select({
      name: participants.name,
      participantId: participants.id,
      amountCents: compensations.amountCents,
      currency: compensations.currency,
      method: compensations.method,
      paidAt: compensations.paidAt,
      reference: compensations.reference,
    })
    .from(compensations)
    .innerJoin(enrollments, eq(compensations.enrollmentId, enrollments.id))
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(compensations.status, "paid"))
    .orderBy(asc(compensations.paidAt));

  const phones = new Map<string, string>();
  if (rows.length > 0) {
    const channels = await db
      .select({
        participantId: contactChannels.participantId,
        value: contactChannels.value,
      })
      .from(contactChannels)
      .where(
        and(
          inArray(
            contactChannels.participantId,
            [...new Set(rows.map((r) => r.participantId))],
          ),
          eq(contactChannels.kind, "phone"),
        ),
      );
    for (const channel of channels) {
      if (!phones.has(channel.participantId)) {
        phones.set(channel.participantId, channel.value);
      }
    }
  }

  return rows.map((row) => ({
    name: row.name,
    phone: phones.get(row.participantId) ?? "",
    amountCents: row.amountCents,
    currency: row.currency,
    method: row.method,
    paidAt: row.paidAt,
    reference: row.reference,
  }));
}
