// IRB approval metadata (spec §3.3): protocol number and approval/expiry
// dates, recorded by the PI. Drives the expiry warnings and, together with
// the approved consent document, the recruiting guard.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Member, studies, type Study } from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { hasRole } from "../auth/roles.ts";
import { type AuditCtx, StudyError } from "./studies.ts";

export const EXPIRY_WARN_DAYS = 30;

export type IrbExpiryStatus = "ok" | "expiring_soon" | "expired";

/** Expiry status for the warning banner; null when no expiry is recorded. */
export function irbExpiryStatus(
  study: Pick<Study, "irbExpiresOn">,
  now = new Date(),
): IrbExpiryStatus | null {
  if (!study.irbExpiresOn) return null;
  const msLeft = study.irbExpiresOn.getTime() - now.getTime();
  if (msLeft < 0) return "expired";
  if (msLeft <= EXPIRY_WARN_DAYS * 24 * 3600 * 1000) return "expiring_soon";
  return "ok";
}

export async function setIrbApproval(
  db: Db,
  opts: {
    study: Study;
    protocolNumber: string;
    approvedOn: Date | null;
    expiresOn: Date | null;
    actor: Member;
  } & AuditCtx,
): Promise<Study> {
  if (!hasRole(opts.actor.role, "pi")) {
    throw new StudyError("Only the PI can record IRB approval metadata.");
  }
  const protocolNumber = opts.protocolNumber.trim();
  if (!protocolNumber) {
    throw new StudyError("The IRB protocol number is required.");
  }
  if (opts.approvedOn && opts.expiresOn && opts.expiresOn <= opts.approvedOn) {
    throw new StudyError("The expiry date must be after the approval date.");
  }

  const [updated] = await db
    .update(studies)
    .set({
      irbProtocolNumber: protocolNumber,
      irbApprovedOn: opts.approvedOn,
      irbExpiresOn: opts.expiresOn,
      updatedAt: new Date(),
    })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.irb_approval_recorded",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: {
      protocolNumber,
      approvedOn: opts.approvedOn?.toISOString().slice(0, 10) ?? null,
      expiresOn: opts.expiresOn?.toISOString().slice(0, 10) ?? null,
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}
