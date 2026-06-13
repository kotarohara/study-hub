import type { Db } from "../../../lib/db/client.ts";
import type { Member, Study, StudySession } from "../../../lib/db/schema.ts";
import { getSession } from "../../../lib/objects/sessions.ts";
import { getStudyFor } from "../../../lib/objects/studies.ts";

/** Session + study, only if the study is visible to `member`. */
export async function getSessionFor(
  db: Db,
  member: Member,
  sessionId: string,
): Promise<{ session: StudySession; study: Study } | null> {
  const session = await getSession(db, sessionId);
  if (!session) return null;
  const found = await getStudyFor(db, member, session.studyId);
  return found ? { session, study: found.study } : null;
}

export function sessionHome(session: StudySession): string {
  return `/studies/${session.studyId}?tab=sessions`;
}
