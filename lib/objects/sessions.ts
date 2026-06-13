// Session scheduling domain logic (spec §4 kept-feature 2): publish open
// slots, let participants self-book via magic link, and track reschedules
// and no-shows. The pseudonymous participant code is the only identifier
// that ever appears on a session row's joins — no PII here.
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Enrollment,
  enrollments,
  type Member,
  participants,
  type Study,
  type StudySession,
  studySessions,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import { signToken, TokenError, verifyToken } from "../crypto/magic_link.ts";
import { type AuditCtx } from "./studies.ts";
import { isTerminal } from "./enrollments.ts";

export class SessionError extends Error {}

export type SessionStatus = StudySession["status"];

/** Booking links live for 30 days — long enough to schedule ahead. */
export const BOOKING_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

const PURPOSE = "booking";

export function bookingLinkFor(enrollment: Enrollment): string {
  const config = getConfig();
  const token = signToken(config.MAGIC_LINK_SECRET, {
    purpose: PURPOSE,
    subject: enrollment.id,
    ttlSeconds: BOOKING_LINK_TTL_SECONDS,
  });
  return `${config.APP_URL}/p/${token}/book`;
}

/** Token → enrollment id, or null for any invalid/expired/foreign token. */
export function verifyBookingToken(token: string): string | null {
  try {
    return verifyToken(getConfig().MAGIC_LINK_SECRET, token, {
      purpose: PURPOSE,
    }).subject;
  } catch (err) {
    if (err instanceof TokenError) return null;
    throw err;
  }
}

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  open: ["booked", "cancelled"],
  // "open" here means a booking was cancelled and the slot is freed again.
  booked: ["completed", "no_show", "cancelled", "open"],
  completed: [],
  no_show: [],
  cancelled: [],
};

export function allowedSessionTransitions(
  status: SessionStatus,
): SessionStatus[] {
  return TRANSITIONS[status];
}

export function isSessionTerminal(status: SessionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Pure: a slot must end after it starts. Publishing also requires the
 * start to be in the future (checked separately so past sessions can still
 * be recorded for completed encounters). */
export function validateSlotTimes(startsAt: Date, endsAt: Date): void {
  if (
    !(startsAt instanceof Date) || !(endsAt instanceof Date) ||
    Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())
  ) {
    throw new SessionError("Start and end times are required.");
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new SessionError("The session must end after it starts.");
  }
  const maxMs = 24 * 60 * 60 * 1000;
  if (endsAt.getTime() - startsAt.getTime() > maxMs) {
    throw new SessionError("A session cannot be longer than 24 hours.");
  }
}

export async function publishSlot(
  db: Db,
  opts: {
    study: Study;
    startsAt: Date;
    endsAt: Date;
    location?: string;
    /** When false (default), the start must be in the future. */
    allowPast?: boolean;
    actor: Member;
  } & AuditCtx,
): Promise<StudySession> {
  validateSlotTimes(opts.startsAt, opts.endsAt);
  if (!opts.allowPast && opts.startsAt.getTime() < Date.now()) {
    throw new SessionError("An open slot must start in the future.");
  }
  const [session] = await db
    .insert(studySessions)
    .values({
      studyId: opts.study.id,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      location: opts.location?.trim() ?? "",
      createdBy: opts.actor.id,
    })
    .returning();
  await audit(db, {
    action: "session.published",
    actorId: opts.actor.id,
    objectType: "session",
    objectId: session.id,
    details: {
      studyId: opts.study.id,
      startsAt: session.startsAt.toISOString(),
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return session;
}

async function participantCode(db: Db, enrollmentId: string): Promise<string> {
  const [row] = await db
    .select({ code: participants.code })
    .from(enrollments)
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(enrollments.id, enrollmentId));
  return row?.code ?? "?";
}

/**
 * Books an open slot for an enrollment. Guards: the slot must be open and
 * (unless `allowPast`) still in the future, and the enrollment must not be
 * in a terminal state. The pilot flag is inherited from the enrollment so
 * pilot sessions stay quarantined. `actor` is null for participant
 * self-booking (audited with actorId null).
 */
export async function bookSession(
  db: Db,
  opts: {
    session: StudySession;
    enrollment: Enrollment;
    actor?: Member | null;
    allowPast?: boolean;
  } & AuditCtx,
): Promise<StudySession> {
  if (opts.session.status !== "open") {
    throw new SessionError("This slot is no longer available.");
  }
  if (!opts.allowPast && opts.session.startsAt.getTime() < Date.now()) {
    throw new SessionError("This slot is in the past.");
  }
  if (isTerminal(opts.enrollment.status)) {
    throw new SessionError(
      "This enrollment has ended and can no longer book sessions.",
    );
  }
  const code = await participantCode(db, opts.enrollment.id);

  return await db.transaction(async (tx) => {
    // Re-read under the row's current state to avoid double-booking a slot
    // two participants opened at once.
    const [claimed] = await tx
      .update(studySessions)
      .set({
        status: "booked",
        enrollmentId: opts.enrollment.id,
        isPilot: opts.enrollment.isPilot,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studySessions.id, opts.session.id),
          eq(studySessions.status, "open"),
        ),
      )
      .returning();
    if (!claimed) {
      throw new SessionError("This slot was just taken — pick another.");
    }
    await audit(tx, {
      action: "session.booked",
      actorId: opts.actor?.id ?? null,
      objectType: "session",
      objectId: claimed.id,
      details: { code, studyId: claimed.studyId },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return claimed;
  });
}

/** Frees a booked slot back to `open` (the booking is undone). */
export async function cancelBooking(
  db: Db,
  opts: { session: StudySession; actor?: Member | null } & AuditCtx,
): Promise<StudySession> {
  if (opts.session.status !== "booked") {
    throw new SessionError("Only a booked session can be unbooked.");
  }
  const code = opts.session.enrollmentId
    ? await participantCode(db, opts.session.enrollmentId)
    : "?";

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(studySessions)
      .set({
        status: "open",
        enrollmentId: null,
        isPilot: false,
        updatedAt: new Date(),
      })
      .where(eq(studySessions.id, opts.session.id))
      .returning();
    await audit(tx, {
      action: "session.booking_cancelled",
      actorId: opts.actor?.id ?? null,
      objectType: "session",
      objectId: updated.id,
      details: { code, studyId: updated.studyId },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return updated;
  });
}

/**
 * Moves a booking from one slot to another atomically: the old slot frees
 * up and the new one is booked. Both slots must belong to the same study.
 */
export async function rescheduleBooking(
  db: Db,
  opts: {
    from: StudySession;
    to: StudySession;
    enrollment: Enrollment;
    actor?: Member | null;
    allowPast?: boolean;
  } & AuditCtx,
): Promise<StudySession> {
  if (opts.from.enrollmentId !== opts.enrollment.id) {
    throw new SessionError("That booking does not belong to this participant.");
  }
  if (opts.to.studyId !== opts.from.studyId) {
    throw new SessionError("Cannot reschedule across studies.");
  }
  if (opts.from.id === opts.to.id) {
    throw new SessionError("Pick a different slot to reschedule into.");
  }
  if (opts.to.status !== "open") {
    throw new SessionError("The new slot is no longer available.");
  }
  if (!opts.allowPast && opts.to.startsAt.getTime() < Date.now()) {
    throw new SessionError("The new slot is in the past.");
  }
  const code = await participantCode(db, opts.enrollment.id);

  return await db.transaction(async (tx) => {
    const [freed] = await tx
      .update(studySessions)
      .set({
        status: "open",
        enrollmentId: null,
        isPilot: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studySessions.id, opts.from.id),
          eq(studySessions.status, "booked"),
        ),
      )
      .returning();
    if (!freed) {
      throw new SessionError("The original booking is no longer active.");
    }
    const [claimed] = await tx
      .update(studySessions)
      .set({
        status: "booked",
        enrollmentId: opts.enrollment.id,
        isPilot: opts.enrollment.isPilot,
        updatedAt: new Date(),
      })
      .where(
        and(eq(studySessions.id, opts.to.id), eq(studySessions.status, "open")),
      )
      .returning();
    if (!claimed) {
      throw new SessionError("The new slot was just taken — pick another.");
    }
    await audit(tx, {
      action: "session.rescheduled",
      actorId: opts.actor?.id ?? null,
      objectType: "session",
      objectId: claimed.id,
      details: { code, from: opts.from.id, studyId: claimed.studyId },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return claimed;
  });
}

/** Lab-side outcome recording: a booked session is completed or a no-show. */
export async function markSessionOutcome(
  db: Db,
  opts: {
    session: StudySession;
    status: "completed" | "no_show";
    actor: Member;
  } & AuditCtx,
): Promise<StudySession> {
  if (opts.session.status !== "booked") {
    throw new SessionError("Only a booked session can be marked.");
  }
  const code = opts.session.enrollmentId
    ? await participantCode(db, opts.session.enrollmentId)
    : "?";
  const [updated] = await db
    .update(studySessions)
    .set({ status: opts.status, updatedAt: new Date() })
    .where(eq(studySessions.id, opts.session.id))
    .returning();
  await audit(db, {
    action: "session.outcome_recorded",
    actorId: opts.actor.id,
    objectType: "session",
    objectId: opts.session.id,
    details: { code, status: opts.status, studyId: updated.studyId },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

/** Cancels an open or booked slot entirely (it leaves the schedule). */
export async function cancelSession(
  db: Db,
  opts: { session: StudySession; actor: Member } & AuditCtx,
): Promise<StudySession> {
  if (isSessionTerminal(opts.session.status)) {
    throw new SessionError("This session is already finalized.");
  }
  const code = opts.session.enrollmentId
    ? await participantCode(db, opts.session.enrollmentId)
    : "?";
  const [updated] = await db
    .update(studySessions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(studySessions.id, opts.session.id))
    .returning();
  await audit(db, {
    action: "session.cancelled",
    actorId: opts.actor.id,
    objectType: "session",
    objectId: opts.session.id,
    details: { code, studyId: updated.studyId },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function getSession(
  db: Db,
  sessionId: string,
): Promise<StudySession | null> {
  const session = await db.query.studySessions.findFirst({
    where: eq(studySessions.id, sessionId),
  });
  return session ?? null;
}

export interface SessionRow {
  session: StudySession;
  /** Pseudonymous code of the booking participant, or null for open slots. */
  participantCode: string | null;
  participantId: string | null;
}

export async function listSessionsOfStudy(
  db: Db,
  studyId: string,
): Promise<SessionRow[]> {
  const rows = await db
    .select({
      session: studySessions,
      participantCode: participants.code,
      participantId: participants.id,
    })
    .from(studySessions)
    .leftJoin(enrollments, eq(studySessions.enrollmentId, enrollments.id))
    .leftJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(studySessions.studyId, studyId))
    .orderBy(asc(studySessions.startsAt));
  return rows;
}

/** Future open slots for a study, for the self-booking page. */
export async function listOpenSlots(
  db: Db,
  studyId: string,
  now: Date = new Date(),
): Promise<StudySession[]> {
  return await db
    .select()
    .from(studySessions)
    .where(
      and(
        eq(studySessions.studyId, studyId),
        eq(studySessions.status, "open"),
        gt(studySessions.startsAt, now),
      ),
    )
    .orderBy(asc(studySessions.startsAt));
}

/** All of an enrollment's sessions (any status), newest scheduled first. */
export async function listSessionsOfEnrollment(
  db: Db,
  enrollmentId: string,
): Promise<StudySession[]> {
  return await db
    .select()
    .from(studySessions)
    .where(eq(studySessions.enrollmentId, enrollmentId))
    .orderBy(asc(studySessions.startsAt));
}
