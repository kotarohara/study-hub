// Records a booked session's outcome: completed or no-show (assistant+).
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  markSessionOutcome,
  SessionError,
} from "../../../lib/objects/sessions.ts";
import { getSessionFor, sessionHome } from "./_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getSessionFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const status = String(form.get("status") ?? "");
    if (status !== "completed" && status !== "no_show") {
      throw new HttpError(400);
    }
    try {
      await markSessionOutcome(db, {
        session: found.session,
        status,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof SessionError) throw new HttpError(409, err.message);
      throw err;
    }
    return ctx.redirect(sessionHome(found.session), 303);
  },
});
