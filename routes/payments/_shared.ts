import type { Db } from "../../lib/db/client.ts";
import type { Compensation, Member } from "../../lib/db/schema.ts";
import { getCompensation } from "../../lib/objects/compensations.ts";
import { getEnrollment } from "../../lib/objects/enrollments.ts";
import { getStudyFor } from "../../lib/objects/studies.ts";

/** Compensation, only if its study is visible to `member`. */
export async function getCompensationFor(
  db: Db,
  member: Member,
  compensationId: string,
): Promise<Compensation | null> {
  const compensation = await getCompensation(db, compensationId);
  if (!compensation) return null;
  const enrollment = await getEnrollment(db, compensation.enrollmentId);
  if (!enrollment) return null;
  const found = await getStudyFor(db, member, enrollment.studyId);
  return found ? compensation : null;
}
