import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import {
  createMilestone,
  MilestoneError,
} from "../../../../lib/objects/milestones.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const dueRaw = String(form.get("dueOn") ?? "").trim();
    try {
      await createMilestone(db, {
        project: found.project,
        study: found.study,
        title: String(form.get("title") ?? ""),
        ownerId: String(form.get("ownerId") ?? "") || null,
        dueOn: dueRaw ? new Date(dueRaw + "T00:00:00Z") : null,
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof MilestoneError) throw new HttpError(400, err.message);
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}?tab=timeline`, 303);
  },
});
