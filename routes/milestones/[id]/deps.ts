import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  addDependency,
  getMilestoneFor,
  MilestoneError,
  removeDependency,
} from "../../../lib/objects/milestones.ts";
import { milestoneHome } from "./_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getMilestoneFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const dependsOnId = String(form.get("dependsOnId") ?? "");
    if (!dependsOnId) throw new HttpError(400);

    try {
      if (action === "add") {
        await addDependency(db, {
          milestone: found.milestone,
          dependsOnId,
          actor: me,
          requestId: ctx.state.requestId,
          ip: clientHost(ctx.info),
        });
      } else if (action === "remove") {
        await removeDependency(db, { milestone: found.milestone, dependsOnId });
      } else {
        throw new HttpError(400);
      }
    } catch (err) {
      if (err instanceof MilestoneError) throw new HttpError(409, err.message);
      throw err;
    }
    return ctx.redirect(milestoneHome(found.milestone), 303);
  },
});
