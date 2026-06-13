import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  allowedEnrollmentTransitions,
  EnrollmentError,
  type EnrollmentStatus,
  transitionEnrollment,
} from "../../../lib/objects/enrollments.ts";
import { enrollmentHome, getEnrollmentFor } from "./_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getEnrollmentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const to = String(form.get("to") ?? "") as EnrollmentStatus;
    if (!allowedEnrollmentTransitions(found.enrollment.status).includes(to)) {
      throw new HttpError(409);
    }
    try {
      await transitionEnrollment(db, {
        enrollment: found.enrollment,
        to,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof EnrollmentError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }
    return ctx.redirect(enrollmentHome(found.enrollment), 303);
  },
});
