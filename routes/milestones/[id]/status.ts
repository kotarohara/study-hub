import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  getMilestoneFor,
  MilestoneError,
  type MilestoneStatus,
  setMilestoneStatus,
} from "../../../lib/objects/milestones.ts";
import { milestoneHome } from "./_shared.ts";

const STATUSES: MilestoneStatus[] = ["pending", "in_progress", "done"];

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getMilestoneFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const to = ctx.url.searchParams.get("to") as MilestoneStatus | null;
    if (!to || !STATUSES.includes(to)) throw new HttpError(400);
    try {
      await setMilestoneStatus(db, {
        milestone: found.milestone,
        status: to,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof MilestoneError) throw new HttpError(409, err.message);
      throw err;
    }
    return ctx.redirect(milestoneHome(found.milestone), 303);
  },
});
