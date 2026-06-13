// Re-recruitment (spec §3.4): filter the lab-wide pool and bulk-invite
// matches into a study via their preferred ContactChannel. Until the
// messaging core lands (Phase 3), "invite" means: create the screened
// enrollment and produce a run sheet of preferred channels for manual
// sending. Compliance guards: do-not-contact participants never match,
// and the default filter requires a consent-to-recontact signature
// (spec: re-recruitment is "subject to consent terms").
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  consents,
  type ContactChannel,
  contactChannels,
  enrollments,
  type Member,
  type Participant,
  participants,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { createEnrollment, EnrollmentError } from "./enrollments.ts";
import type { AuditCtx } from "./studies.ts";

export interface PoolFilter {
  gender?: string;
  minBirthYear?: number | null;
  maxBirthYear?: number | null;
  source?: string;
  /** Only people whose LATEST consent (any study) allows recontact.
   * Untick to include fresh pool entries who never consented to anything. */
  requireRecontact: boolean;
}

/** Pure: does a participant match the demographic filter? (DNC and
 * enrollment/recontact checks need data beyond the row — see filterPool.) */
export function matchesFilter(
  participant: Participant,
  filter: PoolFilter,
): boolean {
  if (participant.doNotContact) return false;
  const gender = filter.gender?.trim().toLowerCase();
  if (gender && participant.gender.trim().toLowerCase() !== gender) {
    return false;
  }
  const source = filter.source?.trim().toLowerCase();
  if (source && participant.source.trim().toLowerCase() !== source) {
    return false;
  }
  const year = participant.yearOfBirth;
  if (
    filter.minBirthYear != null && (year == null || year < filter.minBirthYear)
  ) {
    return false;
  }
  if (
    filter.maxBirthYear != null && (year == null || year > filter.maxBirthYear)
  ) {
    return false;
  }
  return true;
}

export interface PoolMatch {
  participant: Participant;
  /** Preferred channel, falling back to the oldest one; null = unreachable. */
  channel: ContactChannel | null;
  recontactOk: boolean;
}

/** Latest consent's recontact flag per participant (any study). */
async function recontactByParticipant(
  db: Db,
  participantIds: string[],
): Promise<Map<string, boolean>> {
  if (participantIds.length === 0) return new Map();
  const rows = await db
    .select({
      participantId: enrollments.participantId,
      recontact: consents.consentToRecontact,
      signedAt: consents.signedAt,
    })
    .from(consents)
    .innerJoin(enrollments, eq(consents.enrollmentId, enrollments.id))
    .where(inArray(enrollments.participantId, participantIds))
    .orderBy(desc(consents.signedAt));
  const latest = new Map<string, boolean>();
  for (const row of rows) {
    // Rows arrive newest-first; keep only the first per participant.
    if (!latest.has(row.participantId)) {
      latest.set(row.participantId, row.recontact);
    }
  }
  return latest;
}

/** Preferred (else oldest) channel per participant. Values are PII —
 * callers showing them must audit the view. */
export async function preferredChannels(
  db: Db,
  participantIds: string[],
): Promise<Map<string, ContactChannel>> {
  if (participantIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(contactChannels)
    .where(inArray(contactChannels.participantId, participantIds))
    .orderBy(contactChannels.createdAt);
  const byParticipant = new Map<string, ContactChannel>();
  for (const row of rows) {
    const existing = byParticipant.get(row.participantId);
    if (!existing || (row.isPreferred && !existing.isPreferred)) {
      byParticipant.set(row.participantId, row);
    }
  }
  return byParticipant;
}

/** Pool members matching the filter who are not already in the study. */
export async function filterPool(
  db: Db,
  study: Study,
  filter: PoolFilter,
): Promise<PoolMatch[]> {
  const enrolled = new Set(
    (
      await db
        .select({ participantId: enrollments.participantId })
        .from(enrollments)
        .where(eq(enrollments.studyId, study.id))
    ).map((row) => row.participantId),
  );
  const pool = (await db.select().from(participants)).filter(
    (participant) =>
      !enrolled.has(participant.id) && matchesFilter(participant, filter),
  );
  const ids = pool.map((p) => p.id);
  const recontact = await recontactByParticipant(db, ids);
  const channels = await preferredChannels(db, ids);

  return pool
    .map((participant) => ({
      participant,
      channel: channels.get(participant.id) ?? null,
      recontactOk: recontact.get(participant.id) ?? false,
    }))
    .filter((match) => !filter.requireRecontact || match.recontactOk)
    .sort((a, b) => a.participant.code.localeCompare(b.participant.code));
}

export interface BulkInviteResult {
  invited: { participant: Participant; channel: ContactChannel | null }[];
  /** code → reason, for participants that could not be enrolled. */
  skipped: { code: string; reason: string }[];
}

/**
 * Enrolls each selected participant as `screened` (each creation is
 * individually audited by createEnrollment) and records one summary
 * audit event for the bulk action. Duplicates and DNC flags set since
 * the page was rendered are skipped, never fatal.
 */
export async function bulkInvite(
  db: Db,
  opts: {
    study: Study;
    participantIds: string[];
    actor: Member;
  } & AuditCtx,
): Promise<BulkInviteResult> {
  const result: BulkInviteResult = { invited: [], skipped: [] };
  if (opts.participantIds.length === 0) return result;

  const rows = await db
    .select()
    .from(participants)
    .where(inArray(participants.id, opts.participantIds));
  const channels = await preferredChannels(
    db,
    rows.map((p) => p.id),
  );

  for (const participant of rows) {
    try {
      await createEnrollment(db, {
        study: opts.study,
        participant,
        actor: opts.actor,
        requestId: opts.requestId,
        ip: opts.ip,
      });
      result.invited.push({
        participant,
        channel: channels.get(participant.id) ?? null,
      });
    } catch (err) {
      if (err instanceof EnrollmentError) {
        result.skipped.push({ code: participant.code, reason: err.message });
        continue;
      }
      throw err;
    }
  }

  await audit(db, {
    action: "recruitment.bulk_invited",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: {
      invited: result.invited.length,
      skipped: result.skipped.length,
      codes: result.invited.map((row) => row.participant.code),
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return result;
}
