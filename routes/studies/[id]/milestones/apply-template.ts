import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import { applyMethodologyTemplate } from "../../../../lib/objects/milestones.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    await applyMethodologyTemplate(db, {
      project: found.project,
      study: found.study,
      actor: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect(`/studies/${found.study.id}?tab=timeline`, 303);
  },
});
