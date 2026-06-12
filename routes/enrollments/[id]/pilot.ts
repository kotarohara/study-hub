// Toggles the pilot-data flag (spec §4 kept-feature 5) — researcher+.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  EnrollmentError,
  setEnrollmentPilot,
} from "../../../lib/objects/enrollments.ts";
import { enrollmentHome, getEnrollmentFor } from "./_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getEnrollmentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    try {
      await setEnrollmentPilot(db, {
        study: found.study,
        enrollment: found.enrollment,
        isPilot: !found.enrollment.isPilot,
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
