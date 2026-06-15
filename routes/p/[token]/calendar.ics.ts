// Participant calendar feed (spec §4 kept-feature 2: ICS feeds). A
// subscribable .ics URL behind a long-lived, purpose-scoped magic link —
// calendar apps poll it without cookies, so the token is the capability.
// Carries study name + slot times only; never PII.
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { getStudy } from "../../../lib/objects/studies.ts";
import { getEnrollment } from "../../../lib/objects/enrollments.ts";
import {
  enrollmentCalendarEvents,
  listSessionsOfEnrollment,
  verifyCalendarToken,
} from "../../../lib/objects/sessions.ts";
import { buildCalendar } from "../../../lib/calendar/ics.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const enrollmentId = verifyCalendarToken(ctx.params.token);
    if (!enrollmentId) return new Response("Not found", { status: 404 });
    const db = getDb();
    const enrollment = await getEnrollment(db, enrollmentId);
    if (!enrollment) return new Response("Not found", { status: 404 });
    const study = await getStudy(db, enrollment.studyId);
    if (!study) return new Response("Not found", { status: 404 });

    const sessions = await listSessionsOfEnrollment(db, enrollment.id);
    const ics = buildCalendar({
      name: `${study.name} — my sessions`,
      events: enrollmentCalendarEvents(study, sessions),
    });
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="studyhub.ics"',
        // Calendar apps poll periodically; let them cache briefly.
        "cache-control": "private, max-age=300",
      },
    });
  },
});
