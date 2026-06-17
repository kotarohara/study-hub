// Screener domain logic (spec §3.4): a study's public recruitment form.
// Configuration pins an instrument version and eligibility rules; public
// submissions create Participant + Enrollment + response in one
// transaction, with eligibility auto-setting the enrollment status.
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Enrollment,
  enrollments,
  type Instrument,
  type Member,
  type Screener,
  screenerResponses,
  screeners,
  studies,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import { notifyDiscordEvent } from "../integrations/discord.ts";
import {
  type FormItem,
  parseItems,
  parseScoring,
  type RawAnswers,
  type ScoringRule,
  validateResponse,
} from "./forms.ts";
import {
  type EligibilityRule,
  evaluateEligibility,
  parseEligibility,
} from "./eligibility.ts";
import { getVersion } from "./instruments.ts";
import { createParticipant } from "./participants.ts";
import { type AuditCtx, isPilotStudy } from "./studies.ts";

export class ScreenerError extends Error {}

function newToken(): string {
  // 32 hex chars (128 bits) — an opaque capability, not a signed link.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function screenerUrl(screener: Screener): string {
  return `${getConfig().APP_URL}/p/${screener.token}/screener`;
}

export interface ScreenerDefinition {
  items: FormItem[];
  scoring: ScoringRule[];
  rules: EligibilityRule[];
}

/** The pinned form + rules a screener serves. */
export async function screenerDefinition(
  db: Db,
  screener: Screener,
): Promise<ScreenerDefinition> {
  const version = await getVersion(
    db,
    screener.instrumentId,
    screener.instrumentVersionNumber,
  );
  if (!version) throw new ScreenerError("Pinned instrument version missing.");
  const items = parseItems(version.items);
  return {
    items,
    scoring: parseScoring(version.scoring, items),
    rules: parseEligibility(screener.eligibility, items),
  };
}

/**
 * Creates or reconfigures a study's screener. Re-pins the instrument's
 * CURRENT version; eligibility rules are validated against it. The public
 * token survives reconfiguration (links keep working).
 */
export async function configureScreener(
  db: Db,
  opts: {
    study: Study;
    instrument: Instrument;
    eligibility: unknown;
    actor: Member;
  } & AuditCtx,
): Promise<Screener> {
  if (isPilotStudy(opts.study)) {
    // Spec §3.3: Internal Pilot studies have no public recruitment.
    throw new ScreenerError(
      "Internal Pilot studies cannot have a public screener.",
    );
  }
  if (opts.instrument.kind !== "simple_form") {
    throw new ScreenerError("Screeners need a simple-form instrument.");
  }
  const version = await getVersion(
    db,
    opts.instrument.id,
    opts.instrument.currentVersion,
  );
  if (!version) throw new ScreenerError("Instrument has no current version.");
  const items = parseItems(version.items);
  const rules = parseEligibility(opts.eligibility, items);

  return await db.transaction(async (tx) => {
    const existing = await tx.query.screeners.findFirst({
      where: eq(screeners.studyId, opts.study.id),
    });
    let screener: Screener;
    if (existing) {
      [screener] = await tx
        .update(screeners)
        .set({
          instrumentId: opts.instrument.id,
          instrumentVersionNumber: opts.instrument.currentVersion,
          eligibility: rules,
          updatedAt: new Date(),
        })
        .where(eq(screeners.id, existing.id))
        .returning();
    } else {
      [screener] = await tx
        .insert(screeners)
        .values({
          studyId: opts.study.id,
          instrumentId: opts.instrument.id,
          instrumentVersionNumber: opts.instrument.currentVersion,
          eligibility: rules,
          token: newToken(),
          createdBy: opts.actor.id,
        })
        .returning();
    }
    await audit(tx, {
      action: "screener.configured",
      actorId: opts.actor.id,
      objectType: "screener",
      objectId: screener.id,
      details: {
        studyId: opts.study.id,
        instrumentId: opts.instrument.id,
        version: opts.instrument.currentVersion,
        rules: rules.length,
      },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return screener;
  });
}

export async function setScreenerStatus(
  db: Db,
  opts: {
    screener: Screener;
    status: Screener["status"];
    actor: Member;
  } & AuditCtx,
): Promise<Screener> {
  const [updated] = await db
    .update(screeners)
    .set({ status: opts.status, updatedAt: new Date() })
    .where(eq(screeners.id, opts.screener.id))
    .returning();
  await audit(db, {
    action: "screener.status_changed",
    actorId: opts.actor.id,
    objectType: "screener",
    objectId: opts.screener.id,
    details: { status: opts.status },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function getScreenerOfStudy(
  db: Db,
  studyId: string,
): Promise<Screener | null> {
  const screener = await db.query.screeners.findFirst({
    where: eq(screeners.studyId, studyId),
  });
  return screener ?? null;
}

export async function getScreenerByToken(
  db: Db,
  token: string,
): Promise<Screener | null> {
  if (!token) return null;
  const screener = await db.query.screeners.findFirst({
    where: eq(screeners.token, token),
  });
  return screener ?? null;
}

/** Studies whose screener uses an instrument (instrument Usage tab). */
export async function listScreenersOfInstrument(
  db: Db,
  instrumentId: string,
): Promise<{ screener: Screener; studyId: string; studyName: string }[]> {
  return await db
    .select({
      screener: screeners,
      studyId: studies.id,
      studyName: studies.name,
    })
    .from(screeners)
    .innerJoin(studies, eq(screeners.studyId, studies.id))
    .where(eq(screeners.instrumentId, instrumentId));
}

/** A screener accepts the public only while its study is recruiting. */
export function isScreenerLive(screener: Screener, study: Study): boolean {
  return screener.status === "open" && study.status === "recruiting" &&
    !isPilotStudy(study);
}

/** Funnel stat: public page views (counted on GET, pre-submission). */
export async function recordScreenerView(
  db: Db,
  screener: Screener,
): Promise<void> {
  await db
    .update(screeners)
    .set({ views: sql`${screeners.views} + 1` })
    .where(eq(screeners.id, screener.id));
}

export interface ScreenerSubmission {
  enrollment: Enrollment;
  eligible: boolean;
}

/**
 * Handles a validated public submission: creates the pool record (PII
 * encrypted, no member actor), the enrollment (eligible/screened by the
 * rules) and the response row, atomically. Callers must have already
 * checked isScreenerLive, Turnstile and rate limits, and validated `raw`
 * via validateResponse — this re-validates defensively.
 */
export async function submitScreener(
  db: Db,
  opts: {
    screener: Screener;
    study: Study;
    definition: ScreenerDefinition;
    raw: RawAnswers;
    contact: { name: string; email: string };
    ip?: string;
    requestId?: string;
  },
): Promise<ScreenerSubmission> {
  const { answers, errors } = validateResponse(opts.definition.items, opts.raw);
  if (Object.keys(errors).length > 0) {
    throw new ScreenerError("Submission failed validation.");
  }
  const email = opts.contact.email.trim();
  if (!email.includes("@")) {
    throw new ScreenerError("A valid email address is required.");
  }
  const eligible = evaluateEligibility(opts.definition.rules, answers);

  let code = "";
  const result = await db.transaction(async (tx) => {
    const participant = await createParticipant(tx as unknown as Db, {
      name: opts.contact.name,
      source: "screener",
      channels: [{ kind: "email", value: email }],
      createdBy: null,
      requestId: opts.requestId,
      ip: opts.ip,
    });
    code = participant.code;
    const [enrollment] = await tx
      .insert(enrollments)
      .values({
        studyId: opts.study.id,
        participantId: participant.id,
        status: eligible ? "eligible" : "screened",
      })
      .returning();
    await tx.insert(screenerResponses).values({
      screenerId: opts.screener.id,
      enrollmentId: enrollment.id,
      instrumentVersionNumber: opts.screener.instrumentVersionNumber,
      answers,
      eligible,
    });
    await audit(tx, {
      action: "enrollment.screened",
      actorId: null,
      objectType: "enrollment",
      objectId: enrollment.id,
      // Pseudonymous code only — never PII.
      details: { code: participant.code, studyId: opts.study.id, eligible },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return { enrollment, eligible };
  });
  // Notify the lab channel of a new eligible participant (pseudonymous; spec
  // §5.4). Fire-and-forget, no-op when Discord is unconfigured.
  if (result.eligible) {
    void notifyDiscordEvent({
      kind: "enrollment_eligible",
      study: opts.study.name,
      code,
    });
  }
  return result;
}

export interface ResponseRow {
  id: string;
  createdAt: Date;
  eligible: boolean;
  instrumentVersionNumber: number;
  enrollmentId: string;
  participantId: string;
  participantCode: string;
  enrollmentStatus: Enrollment["status"];
  answers: Record<string, unknown>;
}

/** Responses with enrollment + pseudonymous participant code (no PII). */
export async function listScreenerResponses(
  db: Db,
  screenerId: string,
): Promise<ResponseRow[]> {
  const rows = await db
    .select({
      id: screenerResponses.id,
      createdAt: screenerResponses.createdAt,
      eligible: screenerResponses.eligible,
      instrumentVersionNumber: screenerResponses.instrumentVersionNumber,
      enrollmentId: enrollments.id,
      participantId: enrollments.participantId,
      enrollmentStatus: enrollments.status,
      answers: screenerResponses.answers,
      participantCode: sql<string>`(
        select code from participants
        where participants.id = ${enrollments.participantId}
      )`,
    })
    .from(screenerResponses)
    .innerJoin(
      enrollments,
      eq(screenerResponses.enrollmentId, enrollments.id),
    )
    .where(eq(screenerResponses.screenerId, screenerId))
    .orderBy(desc(screenerResponses.createdAt));
  return rows;
}
