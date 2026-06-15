// Publishes an open session slot (researcher+). The datetime-local inputs
// are interpreted in the server's timezone (data residency is ap-southeast-1).
import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import { publishSlot, SessionError } from "../../../../lib/objects/sessions.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const startsAt = new Date(String(form.get("startsAt") ?? ""));
    const endsAt = new Date(String(form.get("endsAt") ?? ""));
    const location = String(form.get("location") ?? "");

    try {
      await publishSlot(db, {
        study: found.study,
        startsAt,
        endsAt,
        location,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof SessionError) throw new HttpError(400, err.message);
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}?tab=sessions`, 303);
  },
});
