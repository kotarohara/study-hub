// Diary / ESM engine domain logic (spec §3.8). Ties the pure schedule
// builder to the database, the messaging core, and the participant magic
// link:
//   configureDiary       — pin a simple-form instrument + window config to a study
//   generatePrompts      — expand the schedule into diary_prompts for an enrollment
//   sweepDueDiaryPrompts  — cron tick: dispatch due prompts, expire stale ones
//   submitDiaryEntry     — store an answered prompt (validated, pinned version)
// Prompts dispatch through the same channel resolution as reminders
// (Telegram-or-email, honoring do-not-contact and /stop). Entries are
// research data tied to a pseudonymous enrollment and never contain PII.
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type DiaryPrompt,
  diaryPrompts,
  diaryResponses,
  type DiarySchedule,
  diarySchedules,
  type Enrollment,
  enrollments,
  type Instrument,
  participants,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import { signToken, TokenError, verifyToken } from "../crypto/magic_link.ts";
import {
  type FormItem,
  type RawAnswers,
  type ScoringRule,
  validateResponse,
} from "./forms.ts";
import { getVersion, versionForm } from "./instruments.ts";
import { enqueueMessage } from "./messaging.ts";
import { resolveContact } from "./notifications.ts";
import { getStudy } from "./studies.ts";
import {
  buildPromptTimes,
  type DiaryWindowType,
  parseDiaryConfig,
} from "./diary_schedule.ts";
import type { AuditCtx } from "./studies.ts";

export class DiaryError extends Error {}

const PURPOSE = "diary";

// --- configuration -------------------------------------------------------

/**
 * Creates or reconfigures a study's diary schedule (one per study). Pins the
 * instrument's CURRENT version and validates the window config for its type.
 * Already-generated prompts are unaffected — reconfiguring changes only what
 * future generation produces.
 */
export async function configureDiary(
  db: Db,
  opts: {
    study: Study;
    instrument: Instrument;
    windowType: DiaryWindowType;
    config: unknown;
    durationDays: number;
    expiryMinutes: number;
    quickReply?: boolean;
    actor: { id: string };
  } & AuditCtx,
): Promise<DiarySchedule> {
  if (opts.instrument.kind !== "simple_form") {
    throw new DiaryError("A diary needs a simple-form instrument.");
  }
  if (!Number.isInteger(opts.durationDays) || opts.durationDays < 1) {
    throw new DiaryError("Duration must be at least one day.");
  }
  if (!Number.isInteger(opts.expiryMinutes) || opts.expiryMinutes < 1) {
    throw new DiaryError("Prompt expiry must be at least one minute.");
  }
  // Validate the window config (throws DiaryScheduleError on bad input).
  parseDiaryConfig(opts.windowType, opts.config);

  const values = {
    studyId: opts.study.id,
    instrumentId: opts.instrument.id,
    instrumentVersionNumber: opts.instrument.currentVersion,
    windowType: opts.windowType,
    config: opts.config as Record<string, unknown>,
    durationDays: opts.durationDays,
    expiryMinutes: opts.expiryMinutes,
    quickReply: opts.quickReply ?? false,
  };

  const [schedule] = await db
    .insert(diarySchedules)
    .values({ ...values, createdBy: opts.actor.id })
    .onConflictDoUpdate({
      target: diarySchedules.studyId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();

  await audit(db, {
    action: "diary.configured",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: {
      instrumentId: opts.instrument.id,
      version: opts.instrument.currentVersion,
      windowType: opts.windowType,
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return schedule;
}

export async function getDiarySchedule(
  db: Db,
  studyId: string,
): Promise<DiarySchedule | null> {
  const schedule = await db.query.diarySchedules.findFirst({
    where: eq(diarySchedules.studyId, studyId),
  });
  return schedule ?? null;
}

/** Parsed form definition of a diary schedule's pinned instrument version. */
export async function diaryDefinition(
  db: Db,
  schedule: DiarySchedule,
): Promise<{ items: FormItem[]; scoring: ScoringRule[] }> {
  const version = await getVersion(
    db,
    schedule.instrumentId,
    schedule.instrumentVersionNumber,
  );
  if (!version) {
    throw new DiaryError("Pinned diary instrument version missing.");
  }
  return versionForm(version);
}

// --- prompt generation ---------------------------------------------------

export interface GenerateResult {
  created: number;
  /** True when prompts already existed for this enrollment (a no-op). */
  skipped: boolean;
}

/**
 * Expands the schedule into diary_prompts for one enrollment, starting at
 * `startAt` (defaults to now). Idempotent: if the enrollment already has
 * prompts for this schedule, nothing is generated (so a second "generate"
 * click — or a re-run with a different randomized draw — never doubles up).
 */
export async function generatePrompts(
  db: Db,
  opts: {
    schedule: DiarySchedule;
    enrollment: Enrollment;
    startAt?: Date;
    rng?: () => number;
  } & AuditCtx,
): Promise<GenerateResult> {
  const existing = await db
    .select({ id: diaryPrompts.id })
    .from(diaryPrompts)
    .where(
      and(
        eq(diaryPrompts.scheduleId, opts.schedule.id),
        eq(diaryPrompts.enrollmentId, opts.enrollment.id),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { created: 0, skipped: true };

  const config = parseDiaryConfig(
    opts.schedule.windowType,
    opts.schedule.config,
  );
  const start = opts.startAt ?? new Date();
  const times = buildPromptTimes(config, {
    start,
    days: opts.schedule.durationDays,
    rng: opts.rng,
  });
  if (times.length === 0) return { created: 0, skipped: false };

  const expiryMs = opts.schedule.expiryMinutes * 60_000;
  await db
    .insert(diaryPrompts)
    .values(times.map((promptAt) => ({
      scheduleId: opts.schedule.id,
      enrollmentId: opts.enrollment.id,
      studyId: opts.schedule.studyId,
      promptAt,
      expiresAt: new Date(promptAt.getTime() + expiryMs),
      isPilot: opts.enrollment.isPilot,
    })))
    .onConflictDoNothing();

  await audit(db, {
    action: "diary.prompts_generated",
    actorId: null,
    objectType: "enrollment",
    objectId: opts.enrollment.id,
    details: { scheduleId: opts.schedule.id, count: times.length },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return { created: times.length, skipped: false };
}

/** Generates prompts for every active enrollment of the schedule's study
 * that does not yet have any. Returns totals across enrollments. */
export async function generatePromptsForActive(
  db: Db,
  opts: { schedule: DiarySchedule; startAt?: Date } & AuditCtx,
): Promise<{ enrollments: number; prompts: number }> {
  const active = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.studyId, opts.schedule.studyId),
        eq(enrollments.status, "active"),
      ),
    );
  let enrolled = 0;
  let prompts = 0;
  for (const enrollment of active) {
    const result = await generatePrompts(db, {
      schedule: opts.schedule,
      enrollment,
      startAt: opts.startAt,
      requestId: opts.requestId,
      ip: opts.ip,
    });
    if (!result.skipped && result.created > 0) {
      enrolled++;
      prompts += result.created;
    }
  }
  return { enrollments: enrolled, prompts };
}

// --- magic link ----------------------------------------------------------

/** Tap-to-answer link for a prompt; lives a little past its answer window. */
export function diaryLinkFor(prompt: DiaryPrompt): string {
  const config = getConfig();
  const ttlSeconds = Math.max(
    3600,
    Math.ceil((prompt.expiresAt.getTime() - Date.now()) / 1000) + 3600,
  );
  const token = signToken(config.MAGIC_LINK_SECRET, {
    purpose: PURPOSE,
    subject: prompt.id,
    ttlSeconds,
  });
  return `${config.APP_URL}/p/${token}/diary`;
}

/** Token → prompt id, or null for any invalid/expired/foreign token. */
export function verifyDiaryToken(token: string): string | null {
  try {
    return verifyToken(getConfig().MAGIC_LINK_SECRET, token, {
      purpose: PURPOSE,
    }).subject;
  } catch (err) {
    if (err instanceof TokenError) return null;
    throw err;
  }
}

export async function getPrompt(
  db: Db,
  promptId: string,
): Promise<DiaryPrompt | null> {
  const prompt = await db.query.diaryPrompts.findFirst({
    where: eq(diaryPrompts.id, promptId),
  });
  return prompt ?? null;
}

// --- dispatch sweep ------------------------------------------------------

export interface DiarySweepResult {
  sent: number;
  missed: number;
  /** Due prompts whose participant was unreachable (marked missed). */
  unreachable: number;
}

/**
 * Cron tick (mirrors sweepDueReminders): first mark any past-expiry prompts
 * `missed`, then dispatch every prompt now due and still answerable as a
 * Message carrying its diary link. Status flips to `sent`, and the enqueue
 * is idempotent (diary:<id>), so repeated sweeps never double-send. The job
 * runner delivers the message via the resolved channel's adapter.
 */
export async function sweepDueDiaryPrompts(
  db: Db,
  opts: { now?: Date } = {},
): Promise<DiarySweepResult> {
  const now = opts.now ?? new Date();
  const result: DiarySweepResult = { sent: 0, missed: 0, unreachable: 0 };

  // Expire prompts whose window closed before they were answered.
  const expired = await db
    .update(diaryPrompts)
    .set({ status: "missed", updatedAt: now })
    .where(
      and(
        inArray(diaryPrompts.status, ["scheduled", "sent"]),
        lte(diaryPrompts.expiresAt, now),
      ),
    )
    .returning({ id: diaryPrompts.id });
  result.missed = expired.length;

  // Dispatch prompts now due and still answerable.
  const due = await db
    .select()
    .from(diaryPrompts)
    .where(
      and(
        eq(diaryPrompts.status, "scheduled"),
        lte(diaryPrompts.promptAt, now),
        gt(diaryPrompts.expiresAt, now),
      ),
    )
    .orderBy(asc(diaryPrompts.promptAt));

  const studies = new Map<string, Study | null>();
  for (const prompt of due) {
    const recipient = await resolveContact(db, prompt.enrollmentId);
    if ("skip" in recipient) {
      // Cannot reach them this window — close it rather than retry forever.
      await db
        .update(diaryPrompts)
        .set({ status: "missed", updatedAt: now })
        .where(eq(diaryPrompts.id, prompt.id));
      result.unreachable++;
      continue;
    }
    if (!studies.has(prompt.studyId)) {
      studies.set(prompt.studyId, await getStudy(db, prompt.studyId));
    }
    const study = studies.get(prompt.studyId);
    if (!study) {
      await db
        .update(diaryPrompts)
        .set({ status: "missed", updatedAt: now })
        .where(eq(diaryPrompts.id, prompt.id));
      result.unreachable++;
      continue;
    }

    await enqueueMessage(db, {
      channel: recipient.channel,
      to: recipient.to,
      templateKey: "diary_prompt",
      fields: {
        first_name: recipient.firstName,
        study_title: study.name,
        diary_link: diaryLinkFor(prompt),
      },
      enrollmentId: prompt.enrollmentId,
      idempotencyKey: `diary:${prompt.id}`,
    });
    await db
      .update(diaryPrompts)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(eq(diaryPrompts.id, prompt.id));
    result.sent++;
  }
  return result;
}

// --- entry submission ----------------------------------------------------

export interface SubmitResult {
  ok: boolean;
  /** True when the prompt was already answered (idempotent re-submit). */
  already?: boolean;
  /** True when the window has closed (expired/missed/cancelled). */
  closed?: boolean;
  /** Per-item validation problems when ok is false. */
  errors?: Record<string, string>;
}

/**
 * Stores a diary entry for a prompt: validates against the pinned form,
 * writes one diary_response, and marks the prompt answered. Refuses a closed
 * window; a re-submit of an already-answered prompt is a no-op.
 */
export async function submitDiaryEntry(
  db: Db,
  opts: {
    prompt: DiaryPrompt;
    items: FormItem[];
    /** The schedule's pinned version — recorded with the entry. */
    instrumentVersionNumber: number;
    raw: RawAnswers;
    now?: Date;
  },
): Promise<SubmitResult> {
  const now = opts.now ?? new Date();
  if (opts.prompt.status === "answered") return { ok: true, already: true };
  if (
    opts.prompt.status === "cancelled" || opts.prompt.status === "missed" ||
    opts.prompt.expiresAt.getTime() <= now.getTime()
  ) {
    return { ok: false, closed: true };
  }

  const { answers, errors } = validateResponse(opts.items, opts.raw);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  await db.transaction(async (tx) => {
    await tx
      .insert(diaryResponses)
      .values({
        promptId: opts.prompt.id,
        enrollmentId: opts.prompt.enrollmentId,
        instrumentVersionNumber: opts.instrumentVersionNumber,
        answers,
      })
      .onConflictDoNothing();
    await tx
      .update(diaryPrompts)
      .set({ status: "answered", answeredAt: now, updatedAt: now })
      .where(eq(diaryPrompts.id, opts.prompt.id));
  });
  return { ok: true };
}

// --- listing (pseudonymous) ----------------------------------------------

export interface DiaryProgressRow {
  participantCode: string;
  total: number;
  answered: number;
  missed: number;
  pending: number;
}

/** Per-enrollment diary progress for the study Diary tab — participant code
 * only, never PII. */
export async function diaryProgress(
  db: Db,
  studyId: string,
): Promise<DiaryProgressRow[]> {
  const rows = await db
    .select({
      code: participants.code,
      status: diaryPrompts.status,
    })
    .from(diaryPrompts)
    .innerJoin(enrollments, eq(diaryPrompts.enrollmentId, enrollments.id))
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(diaryPrompts.studyId, studyId));

  const byCode = new Map<string, DiaryProgressRow>();
  for (const row of rows) {
    let agg = byCode.get(row.code);
    if (!agg) {
      agg = {
        participantCode: row.code,
        total: 0,
        answered: 0,
        missed: 0,
        pending: 0,
      };
      byCode.set(row.code, agg);
    }
    agg.total++;
    if (row.status === "answered") agg.answered++;
    else if (row.status === "missed" || row.status === "cancelled") {
      agg.missed++;
    } else agg.pending++;
  }
  return [...byCode.values()].sort((a, b) =>
    a.participantCode.localeCompare(b.participantCode)
  );
}
