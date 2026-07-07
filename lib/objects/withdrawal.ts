// Withdrawal + retention + purge (spec §3.4 "withdrawal/erasure workflow",
// §7 retention). Three graduated responses to "I'm done / forget me":
//
//   withdrawEnrollment  one study: enrollment → withdrawn, future
//                       obligations cancelled (scheduled diary prompts,
//                       future booked sessions freed), and the collected
//                       data handled per what the consent form permits —
//                       retained, or deleted.
//   purgeCandidates     retention timer surface: participants whose every
//                       enrollment is terminal and who have been inactive
//                       past a cutoff.
//   purgeParticipant    PI-approved erasure: PII destroyed (name
//                       overwritten, channels deleted), pseudonymous code
//                       and research data kept so published analyses stay
//                       reproducible. Audited, irreversible.
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  contactChannels,
  datasetRecords,
  diaryPrompts,
  diaryResponses,
  type Enrollment,
  enrollments,
  type Member,
  type Participant,
  participants,
  screenerResponses,
  studySessions,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { transitionEnrollment } from "./enrollments.ts";
import { isTerminal } from "./enrollments.ts";
import type { AuditCtx } from "./studies.ts";

export type WithdrawalDataHandling = "retain" | "delete";

export interface WithdrawalResult {
  enrollment: Enrollment;
  cancelledPrompts: number;
  freedSessions: number;
  deletedRecords: number;
}

/**
 * Withdraws an enrollment (spec §3.4): the lifecycle transition plus
 * everything the transition alone would leave dangling. `dataHandling`
 * records what the signed consent permits for already-collected data —
 * "retain" keeps it (linked pseudonymously), "delete" removes the
 * enrollment's dataset records, diary responses, and screener answers.
 * Every part is audited via the transition audit + a withdrawal audit
 * carrying the counts.
 */
export async function withdrawEnrollment(
  db: Db,
  opts: {
    enrollment: Enrollment;
    dataHandling: WithdrawalDataHandling;
    reason?: string;
    actor: Member;
  } & AuditCtx,
): Promise<WithdrawalResult> {
  const enrollment = await transitionEnrollment(db, {
    enrollment: opts.enrollment,
    to: "withdrawn",
    actor: opts.actor,
    requestId: opts.requestId,
    ip: opts.ip,
  });

  // Future obligations end now: pending diary prompts are cancelled…
  const cancelled = await db
    .update(diaryPrompts)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(diaryPrompts.enrollmentId, enrollment.id),
        inArray(diaryPrompts.status, ["scheduled", "sent"]),
      ),
    )
    .returning({ id: diaryPrompts.id });

  // …and future booked sessions return to the open pool.
  const freed = await db
    .update(studySessions)
    .set({
      status: "open",
      enrollmentId: null,
      isPilot: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(studySessions.enrollmentId, enrollment.id),
        eq(studySessions.status, "booked"),
        gt(studySessions.startsAt, new Date()),
      ),
    )
    .returning({ id: studySessions.id });

  let deletedRecords = 0;
  if (opts.dataHandling === "delete") {
    const records = await db
      .delete(datasetRecords)
      .where(eq(datasetRecords.enrollmentId, enrollment.id))
      .returning({ id: datasetRecords.id });
    const diary = await db
      .delete(diaryResponses)
      .where(eq(diaryResponses.enrollmentId, enrollment.id))
      .returning({ id: diaryResponses.id });
    const screener = await db
      .delete(screenerResponses)
      .where(eq(screenerResponses.enrollmentId, enrollment.id))
      .returning({ id: screenerResponses.id });
    deletedRecords = records.length + diary.length + screener.length;
  }

  await audit(db, {
    action: "enrollment.withdrawal_processed",
    actorId: opts.actor.id,
    objectType: "enrollment",
    objectId: enrollment.id,
    details: {
      dataHandling: opts.dataHandling,
      reason: opts.reason?.trim() || undefined,
      cancelledPrompts: cancelled.length,
      freedSessions: freed.length,
      deletedRecords,
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });

  return {
    enrollment,
    cancelledPrompts: cancelled.length,
    freedSessions: freed.length,
    deletedRecords,
  };
}

export interface PurgeCandidate {
  participant: Participant;
  enrollmentCount: number;
  /** Days since the participant row was last touched. */
  inactiveDays: number;
}

/** Default retention window before a participant becomes purge-eligible:
 * three years of inactivity with no live enrollments (PDPA-minded; the
 * page lets the PI pick a different window). */
export const DEFAULT_RETENTION_DAYS = 3 * 365;

/**
 * Participants the retention timer has run out on: every enrollment is
 * terminal (or none exist) and the record has been untouched for
 * `retentionDays`. Purging is never automatic — the PI approves each one.
 */
export async function purgeCandidates(
  db: Db,
  opts: { retentionDays?: number; now?: Date } = {},
): Promise<PurgeCandidate[]> {
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() -
    (opts.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86_400_000;

  const pool = await db.select().from(participants);
  const allEnrollments = await db
    .select({
      participantId: enrollments.participantId,
      status: enrollments.status,
    })
    .from(enrollments);
  const byParticipant = new Map<string, string[]>();
  for (const e of allEnrollments) {
    const list = byParticipant.get(e.participantId) ?? [];
    list.push(e.status);
    byParticipant.set(e.participantId, list);
  }

  const candidates: PurgeCandidate[] = [];
  for (const participant of pool) {
    if (participant.name === "[purged]") continue; // already erased
    if (participant.updatedAt.getTime() > cutoffMs) continue;
    const statuses = byParticipant.get(participant.id) ?? [];
    if (!statuses.every((s) => isTerminal(s as Enrollment["status"]))) {
      continue;
    }
    candidates.push({
      participant,
      enrollmentCount: statuses.length,
      inactiveDays: Math.floor(
        (now.getTime() - participant.updatedAt.getTime()) / 86_400_000,
      ),
    });
  }
  return candidates.sort((a, b) => b.inactiveDays - a.inactiveDays);
}

export interface PurgeResult {
  channelsDeleted: number;
}

/**
 * PI-approved erasure (route enforces the PI gate): destroys the
 * participant's PII — contact channels deleted, name/notes/demographics
 * overwritten — while the pseudonymous code, enrollments, and research
 * records survive, so datasets and published analyses stay intact.
 * Audited with the code only. Irreversible by design.
 */
export async function purgeParticipant(
  db: Db,
  opts: { participant: Participant; actor: Member } & AuditCtx,
): Promise<PurgeResult> {
  const deleted = await db
    .delete(contactChannels)
    .where(eq(contactChannels.participantId, opts.participant.id))
    .returning({ id: contactChannels.id });
  await db
    .update(participants)
    .set({
      name: "[purged]",
      notes: "",
      yearOfBirth: null,
      gender: "",
      source: "",
      doNotContact: true,
      updatedAt: new Date(),
    })
    .where(eq(participants.id, opts.participant.id));

  // Deletion must never go unrecorded (spec §4) — and the entry carries
  // only the pseudonymous code.
  await audit(db, {
    action: "participant.purged",
    actorId: opts.actor.id,
    objectType: "participant",
    objectId: opts.participant.id,
    details: {
      code: opts.participant.code,
      channelsDeleted: deleted.length,
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return { channelsDeleted: deleted.length };
}
