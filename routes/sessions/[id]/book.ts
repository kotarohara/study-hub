// Lab-side booking of an open slot onto an enrollment (assistant+).
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getEnrollment } from "../../../lib/objects/enrollments.ts";
import { bookSession, SessionError } from "../../../lib/objects/sessions.ts";
import { notifyBookingConfirmed } from "../../../lib/objects/notifications.ts";
import { getSessionFor, sessionHome } from "./_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getSessionFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const enrollment = await getEnrollment(
      db,
      String(form.get("enrollmentId") ?? ""),
    );
    if (!enrollment || enrollment.studyId !== found.study.id) {
      throw new HttpError(400);
    }
    let booked;
    try {
      booked = await bookSession(db, {
        session: found.session,
        enrollment,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof SessionError) throw new HttpError(409, err.message);
      throw err;
    }
    await notifyBookingConfirmed(db, booked.id);
    return ctx.redirect(sessionHome(found.session), 303);
  },
});
