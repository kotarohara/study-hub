// Generates diary prompts for a study's active enrollments (assistant+).
// Idempotent per enrollment, so it is safe to click again as new
// participants become active (spec §3.8).
import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import {
  generatePromptsForActive,
  getDiarySchedule,
} from "../../../../lib/objects/diary.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const schedule = await getDiarySchedule(db, found.study.id);
    if (!schedule) throw new HttpError(400, "Configure the diary first.");

    await generatePromptsForActive(db, {
      schedule,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect(`/studies/${found.study.id}?tab=diary`, 303);
  },
});
