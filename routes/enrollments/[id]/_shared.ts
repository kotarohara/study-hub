import type { Db } from "../../../lib/db/client.ts";
import type { Enrollment, Member, Study } from "../../../lib/db/schema.ts";
import { getEnrollment } from "../../../lib/objects/enrollments.ts";
import { getStudyFor } from "../../../lib/objects/studies.ts";

/** Enrollment + study, only if the study is visible to `member`. */
export async function getEnrollmentFor(
  db: Db,
  member: Member,
  enrollmentId: string,
): Promise<{ enrollment: Enrollment; study: Study } | null> {
  const enrollment = await getEnrollment(db, enrollmentId);
  if (!enrollment) return null;
  const found = await getStudyFor(db, member, enrollment.studyId);
  return found ? { enrollment, study: found.study } : null;
}

export function enrollmentHome(enrollment: Enrollment): string {
  return `/studies/${enrollment.studyId}?tab=participants`;
}
