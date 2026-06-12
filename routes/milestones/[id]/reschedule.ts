// Drag-to-reschedule target for the TimelineGantt island.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import {
  getMilestoneFor,
  MilestoneError,
  rescheduleMilestone,
} from "../../../lib/objects/milestones.ts";

function parseDate(raw: string): Date | null {
  if (!raw.trim()) return null;
  const d = new Date(raw + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new MilestoneError("Invalid date.");
  return d;
}

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getMilestoneFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      await rescheduleMilestone(db, {
        milestone: found.milestone,
        startsOn: parseDate(String(form.get("startsOn") ?? "")),
        dueOn: parseDate(String(form.get("dueOn") ?? "")),
        actor: me,
      });
    } catch (err) {
      if (err instanceof MilestoneError) throw new HttpError(400, err.message);
      throw err;
    }
    return new Response(null, { status: 204 });
  },
});
