import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor, StudyError } from "../../../../lib/objects/studies.ts";
import { removeCondition } from "../../../../lib/objects/design.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      await removeCondition(db, {
        study: found.study,
        conditionId: String(form.get("conditionId") ?? ""),
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof StudyError) throw new HttpError(409, err.message);
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}/design`, 303);
  },
});
