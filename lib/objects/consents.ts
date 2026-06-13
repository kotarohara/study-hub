// Consent flow domain logic (spec §4 kept-feature 1): participants sign
// a specific APPROVED version of the study's consent Document via a
// purpose-scoped magic link. Amendments make existing consents outdated;
// re-consent records a new row — the agreement history is immutable.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Consent,
  consents,
  type Document,
  documents,
  type Enrollment,
  enrollments,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import { errorChainIncludes } from "../db/errors.ts";
import { signToken, TokenError, verifyToken } from "../crypto/magic_link.ts";

export class ConsentError extends Error {}

/** Consent links live for two weeks — long enough to think it over. */
export const CONSENT_LINK_TTL_SECONDS = 14 * 24 * 60 * 60;

const PURPOSE = "consent";

export function consentLinkFor(enrollment: Enrollment): string {
  const config = getConfig();
  const token = signToken(config.MAGIC_LINK_SECRET, {
    purpose: PURPOSE,
    subject: enrollment.id,
    ttlSeconds: CONSENT_LINK_TTL_SECONDS,
  });
  return `${config.APP_URL}/p/${token}/consent`;
}

/** Token → enrollment id, or null for any invalid/expired/foreign token. */
export function verifyConsentToken(token: string): string | null {
  try {
    return verifyToken(getConfig().MAGIC_LINK_SECRET, token, {
      purpose: PURPOSE,
    }).subject;
  } catch (err) {
    if (err instanceof TokenError) return null;
    throw err;
  }
}

/** The study's approved consent form, if any (any oversight pathway). */
export async function requiredConsentDocument(
  db: Db,
  study: Study,
): Promise<Document | null> {
  const document = await db.query.documents.findFirst({
    where: and(
      eq(documents.studyId, study.id),
      eq(documents.kind, "consent_form"),
      eq(documents.reviewStatus, "approved"),
    ),
  });
  return document ?? null;
}

export type ConsentStatus = "no_document" | "none" | "current" | "outdated";

export interface ConsentState {
  status: ConsentStatus;
  /** The approved consent form to (re-)sign, when one exists. */
  document: Document | null;
  /** Most recent signature, when any. */
  latest: Consent | null;
}

export async function getConsentState(
  db: Db,
  opts: { enrollment: Enrollment; study: Study },
): Promise<ConsentState> {
  const document = await requiredConsentDocument(db, opts.study);
  const [latest] = await db
    .select()
    .from(consents)
    .where(eq(consents.enrollmentId, opts.enrollment.id))
    .orderBy(desc(consents.signedAt))
    .limit(1);
  if (!document) {
    return { status: "no_document", document: null, latest: latest ?? null };
  }
  if (!latest) return { status: "none", document, latest: null };
  const current = latest.documentId === document.id &&
    latest.documentVersionNumber === document.currentVersion;
  return { status: current ? "current" : "outdated", document, latest };
}

/** Enrollment states from which the consent page accepts a signature:
 * first consent from `eligible`, re-consent while consented/active. */
const CONSENTABLE: Enrollment["status"][] = ["eligible", "consented", "active"];

export function mayConsent(enrollment: Enrollment): boolean {
  return CONSENTABLE.includes(enrollment.status);
}

/**
 * Records a participant's signature on the CURRENT approved version and
 * advances an `eligible` enrollment to `consented`. Participant-initiated:
 * there is no member actor; audit rows carry actorId null. All writes and
 * both audit events share one transaction — consent must never go
 * half-recorded.
 */
export async function recordConsent(
  db: Db,
  opts: {
    enrollment: Enrollment;
    study: Study;
    participantCode: string;
    signatureName: string;
    consentToRecontact: boolean;
    requestId?: string;
    ip?: string;
  },
): Promise<Consent> {
  const signatureName = opts.signatureName.trim();
  if (!signatureName) {
    throw new ConsentError("Please type your full name as your signature.");
  }
  if (!mayConsent(opts.enrollment)) {
    throw new ConsentError("This enrollment can no longer consent.");
  }
  const state = await getConsentState(db, opts);
  if (state.status === "no_document") {
    throw new ConsentError("This study has no approved consent form.");
  }
  if (state.status === "current") {
    throw new ConsentError(
      "The current consent form has already been signed.",
    );
  }
  const document = state.document!;

  try {
    return await db.transaction(async (tx) => {
      const [consent] = await tx
        .insert(consents)
        .values({
          enrollmentId: opts.enrollment.id,
          documentId: document.id,
          documentVersionNumber: document.currentVersion,
          signatureName,
          consentToRecontact: opts.consentToRecontact,
        })
        .returning();
      await audit(tx, {
        action: "consent.given",
        actorId: null,
        objectType: "enrollment",
        objectId: opts.enrollment.id,
        details: {
          code: opts.participantCode,
          documentId: document.id,
          version: document.currentVersion,
          recontact: opts.consentToRecontact,
          reconsent: state.status === "outdated",
        },
        requestId: opts.requestId,
        ip: opts.ip,
      });
      if (opts.enrollment.status === "eligible") {
        await tx
          .update(enrollments)
          .set({ status: "consented", updatedAt: new Date() })
          .where(eq(enrollments.id, opts.enrollment.id));
        await audit(tx, {
          action: "enrollment.status_changed",
          actorId: null,
          objectType: "enrollment",
          objectId: opts.enrollment.id,
          details: {
            code: opts.participantCode,
            from: "eligible",
            to: "consented",
            via: "consent_page",
          },
          requestId: opts.requestId,
          ip: opts.ip,
        });
      }
      return consent;
    });
  } catch (err) {
    if (errorChainIncludes(err, "consents_enrollment_version_unique")) {
      throw new ConsentError(
        "The current consent form has already been signed.",
      );
    }
    throw err;
  }
}

export async function listConsents(
  db: Db,
  enrollmentId: string,
): Promise<Consent[]> {
  return await db
    .select()
    .from(consents)
    .where(eq(consents.enrollmentId, enrollmentId))
    .orderBy(desc(consents.signedAt));
}

/** Batch consent status per enrollment for the study Participants tab. */
export async function consentStatusOfStudy(
  db: Db,
  study: Study,
  rows: Enrollment[],
): Promise<Map<string, ConsentStatus>> {
  const statuses = new Map<string, ConsentStatus>();
  if (rows.length === 0) return statuses;
  const document = await requiredConsentDocument(db, study);
  const all = await db
    .select()
    .from(consents)
    .where(inArray(consents.enrollmentId, rows.map((e) => e.id)));
  const latestByEnrollment = new Map<string, Consent>();
  for (const row of all) {
    const existing = latestByEnrollment.get(row.enrollmentId);
    if (!existing || row.signedAt > existing.signedAt) {
      latestByEnrollment.set(row.enrollmentId, row);
    }
  }
  for (const enrollment of rows) {
    const latest = latestByEnrollment.get(enrollment.id);
    if (!document) statuses.set(enrollment.id, "no_document");
    else if (!latest) statuses.set(enrollment.id, "none");
    else if (
      latest.documentId === document.id &&
      latest.documentVersionNumber === document.currentVersion
    ) statuses.set(enrollment.id, "current");
    else statuses.set(enrollment.id, "outdated");
  }
  return statuses;
}
