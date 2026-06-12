import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import { getParticipant } from "../../../../lib/objects/participants.ts";
import {
  createEnrollment,
  EnrollmentError,
} from "../../../../lib/objects/enrollments.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const participant = await getParticipant(
      db,
      String(form.get("participantId") ?? ""),
    );
    if (!participant) throw new HttpError(400);

    try {
      await createEnrollment(db, {
        study: found.study,
        participant,
        isPilot: form.get("isPilot") === "1",
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof EnrollmentError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}?tab=participants`, 303);
  },
});
