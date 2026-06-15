// Configures a study's diary schedule (researcher+): pins a diary-purpose
// simple-form instrument and the window strategy (spec §3.8).
import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import { getInstrument } from "../../../../lib/objects/instruments.ts";
import { configureDiary, DiaryError } from "../../../../lib/objects/diary.ts";
import {
  DiaryScheduleError,
  type DiaryWindowType,
} from "../../../../lib/objects/diary_schedule.ts";

function buildConfig(windowType: string, form: FormData): unknown {
  switch (windowType) {
    case "fixed":
      return {
        type: "fixed",
        times: String(form.get("times") ?? "").split(",").map((s) => s.trim())
          .filter(Boolean),
      };
    case "interval":
      return {
        type: "interval",
        everyMinutes: Number(form.get("everyMinutes")),
        dayStart: String(form.get("dayStart") ?? ""),
        dayEnd: String(form.get("dayEnd") ?? ""),
      };
    case "randomized":
      return {
        type: "randomized",
        perDay: Number(form.get("perDay")),
        dayStart: String(form.get("dayStart") ?? ""),
        dayEnd: String(form.get("dayEnd") ?? ""),
        minGapMinutes: Number(form.get("minGapMinutes") || 0),
      };
    default:
      return { type: windowType };
  }
}

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const instrument = await getInstrument(
      db,
      String(form.get("instrumentId") ?? ""),
    );
    if (!instrument) throw new HttpError(400, "Pick a diary instrument.");
    const windowType = String(form.get("windowType") ?? "");

    try {
      await configureDiary(db, {
        study: found.study,
        instrument,
        windowType: windowType as DiaryWindowType,
        config: buildConfig(windowType, form),
        durationDays: Number(form.get("durationDays")),
        expiryMinutes: Number(form.get("expiryMinutes")),
        quickReply: form.get("quickReply") === "on",
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof DiaryError || err instanceof DiaryScheduleError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}?tab=diary`, 303);
  },
});
