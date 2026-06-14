// Study calendar feed for lab members (spec §4 kept-feature 2). Served to
// the authenticated browser session (the route is member-gated), so it is
// a download/subscribe-while-signed-in feed of every session in the study.
// Pseudonymous codes only — no PII.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { getStudyFor } from "../../../lib/objects/studies.ts";
import {
  listSessionsOfStudy,
  studyCalendarEvents,
} from "../../../lib/objects/sessions.ts";
import { buildCalendar } from "../../../lib/calendar/ics.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getStudyFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);

    const rows = await listSessionsOfStudy(db, found.study.id);
    const ics = buildCalendar({
      name: `${found.study.name} — sessions`,
      events: studyCalendarEvents(rows),
    });
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'attachment; filename="study-sessions.ics"',
      },
    });
  },
});
