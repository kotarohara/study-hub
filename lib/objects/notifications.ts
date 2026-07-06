// Automated participant comms (spec §3.8, §4 kept-feature 2): booking
// confirmations and session reminders. These resolve the participant's best
// reachable channel, enforce the compliance gates deferred from earlier
// phases (do-not-contact, bounce-suppressed channels), and enqueue an
// idempotent message — the job runner (3.5) delivers it via the channel's
// adapter. No PII leaves here in the clear: the body is encrypted by the
// messaging core (the messages table is the delivery log).
import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  contactChannels,
  enrollments,
  type MessageChannel,
  participants,
  type Study,
  type StudySession,
  studySessions,
} from "../db/schema.ts";
import { enqueueMessage } from "./messaging.ts";
import { getStudy } from "./studies.ts";
import { getSession } from "./sessions.ts";

/** Default reminder lead time: a booked session within 24h gets reminded. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

export interface NotifyResult {
  enqueued: boolean;
  /** Why nothing was sent: "not_booked" | "do_not_contact" | "no_channel". */
  reason?: string;
}

export interface Recipient {
  channel: MessageChannel;
  to: string;
  firstName: string;
}

/**
 * Resolves the best reachable channel for an enrollment, or a skip reason.
 * Honors do-not-contact and suppression (bounce, or a Telegram `/stop`).
 * A *verified* Telegram chat wins over email — pairing is an explicit
 * "reach me here" — and `/stop` suppresses it back to the email fallback.
 * Within a kind the preferred address is used, else the first usable one.
 * Shared with the diary engine (3.8), which dispatches through the same
 * channel logic.
 */
export async function resolveContact(
  db: Db,
  enrollmentId: string,
): Promise<Recipient | { skip: string }> {
  const [row] = await db
    .select({
      doNotContact: participants.doNotContact,
      name: participants.name,
      participantId: participants.id,
    })
    .from(enrollments)
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(enrollments.id, enrollmentId));
  if (!row) return { skip: "not_booked" };
  if (row.doNotContact) return { skip: "do_not_contact" };

  const channels = await db
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.participantId, row.participantId),
        eq(contactChannels.suppressed, false),
      ),
    );

  const firstName = row.name.trim().split(/\s+/)[0] || row.name;
  const pick = (kind: MessageChannel) => {
    const matches = channels.filter((c) =>
      c.kind === kind && (kind !== "telegram" || c.verified)
    );
    if (matches.length === 0) return null;
    return matches.find((c) => c.isPreferred) ?? matches[0];
  };

  const telegram = pick("telegram");
  if (telegram) return { channel: "telegram", to: telegram.value, firstName };
  const email = pick("email");
  if (email) return { channel: "email", to: email.value, firstName };
  return { skip: "no_channel" };
}

function fmtTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function sessionFields(
  recipient: Recipient,
  study: Study,
  session: StudySession,
): Record<string, string> {
  return {
    first_name: recipient.firstName,
    study_title: study.name,
    session_time: fmtTime(session.startsAt),
    session_location: session.location ? ` at ${session.location}` : "",
  };
}

/** Enqueues a booking confirmation for a booked session (idempotent per
 * session). Skips silently when the participant is unreachable. */
export async function notifyBookingConfirmed(
  db: Db,
  sessionId: string,
): Promise<NotifyResult> {
  const session = await getSession(db, sessionId);
  if (!session || session.status !== "booked" || !session.enrollmentId) {
    return { enqueued: false, reason: "not_booked" };
  }
  const study = await getStudy(db, session.studyId);
  if (!study) return { enqueued: false, reason: "not_booked" };

  const recipient = await resolveContact(db, session.enrollmentId);
  if ("skip" in recipient) return { enqueued: false, reason: recipient.skip };

  await enqueueMessage(db, {
    channel: recipient.channel,
    to: recipient.to,
    templateKey: "booking_confirmation",
    fields: sessionFields(recipient, study, session),
    enrollmentId: session.enrollmentId,
    sessionId: session.id,
    idempotencyKey: `confirm:${session.id}`,
  });
  return { enqueued: true };
}

/**
 * Enqueues a payment confirmation for a paid compensation (spec §3.9,
 * idempotent per compensation). Same compliance gates as every other send.
 */
export async function notifyPaymentSent(
  db: Db,
  opts: {
    compensationId: string;
    enrollmentId: string;
    studyId: string;
    amountLabel: string;
  },
): Promise<NotifyResult> {
  const study = await getStudy(db, opts.studyId);
  if (!study) return { enqueued: false, reason: "not_booked" };
  const recipient = await resolveContact(db, opts.enrollmentId);
  if ("skip" in recipient) return { enqueued: false, reason: recipient.skip };

  await enqueueMessage(db, {
    channel: recipient.channel,
    to: recipient.to,
    templateKey: "payment_confirmation",
    fields: {
      first_name: recipient.firstName,
      study_title: study.name,
      amount: opts.amountLabel,
    },
    enrollmentId: opts.enrollmentId,
    idempotencyKey: `payment:${opts.compensationId}`,
  });
  return { enqueued: true };
}

export interface SweepResult {
  enqueued: number;
  skipped: number;
}

/**
 * Enqueues reminders for every booked session starting within the lead
 * window. Idempotent per session, so repeated sweeps never double-remind;
 * reschedules and cancellations are handled for free because the sweep
 * reads live session state (a cancelled/unbooked slot is no longer
 * "booked"). The job runner sends them.
 */
export async function sweepDueReminders(
  db: Db,
  opts: { now?: Date; leadMs?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() + (opts.leadMs ?? REMINDER_LEAD_MS));

  const due = await db
    .select()
    .from(studySessions)
    .where(
      and(
        eq(studySessions.status, "booked"),
        gt(studySessions.startsAt, now),
        lte(studySessions.startsAt, cutoff),
      ),
    )
    .orderBy(asc(studySessions.startsAt));

  const result: SweepResult = { enqueued: 0, skipped: 0 };
  const studies = new Map<string, Study | null>();

  for (const session of due) {
    if (!session.enrollmentId) {
      result.skipped++;
      continue;
    }
    const recipient = await resolveContact(db, session.enrollmentId);
    if ("skip" in recipient) {
      result.skipped++;
      continue;
    }
    if (!studies.has(session.studyId)) {
      studies.set(session.studyId, await getStudy(db, session.studyId));
    }
    const study = studies.get(session.studyId);
    if (!study) {
      result.skipped++;
      continue;
    }
    const { deduped } = await enqueueMessage(db, {
      channel: recipient.channel,
      to: recipient.to,
      templateKey: "session_reminder",
      fields: sessionFields(recipient, study, session),
      enrollmentId: session.enrollmentId,
      sessionId: session.id,
      idempotencyKey: `reminder:${session.id}`,
    });
    if (deduped) result.skipped++;
    else result.enqueued++;
  }
  return result;
}
