// Append-only audit log write helper (spec §4). Immutability is enforced by
// database triggers; this module only ever inserts.
//
// RULES for callers:
// - `details` must never contain participant PII (use pseudonymous ids).
// - Write BEFORE returning success for actions that must not go unrecorded
//   (exports, deletions, payment approvals): a failed audit write should
//   fail the action.
import type { Db } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";

export interface AuditEvent {
  /** Namespaced verb: "auth.login", "pii.view", "export.create", ... */
  action: string;
  /** Acting member id; omit for system/participant actions. */
  actorId?: string | null;
  objectType?: string;
  objectId?: string;
  /** Extra context — never PII. */
  details?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
}

export async function audit(db: Db, event: AuditEvent): Promise<void> {
  await db.insert(auditLog).values({
    action: event.action,
    actorId: event.actorId ?? null,
    objectType: event.objectType,
    objectId: event.objectId,
    details: event.details,
    requestId: event.requestId,
    ip: event.ip,
  });
}
