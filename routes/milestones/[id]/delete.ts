import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  deleteMilestone,
  getMilestoneFor,
} from "../../../lib/objects/milestones.ts";
import { milestoneHome } from "./_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getMilestoneFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    await deleteMilestone(db, {
      milestone: found.milestone,
      actor: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect(milestoneHome(found.milestone), 303);
  },
});
