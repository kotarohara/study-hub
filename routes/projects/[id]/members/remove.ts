import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import {
  getProjectFor,
  removeProjectMember,
} from "../../../../lib/objects/projects.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const project = await getProjectFor(db, me, ctx.params.id);
    if (!project) throw new HttpError(404);
    if (project.status !== "active") throw new HttpError(409);

    const form = await ctx.req.formData();
    const memberId = String(form.get("memberId") ?? "");
    if (memberId) {
      await removeProjectMember(db, {
        project,
        memberId,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    }
    return ctx.redirect(`/projects/${project.id}?tab=members`, 303);
  },
});
