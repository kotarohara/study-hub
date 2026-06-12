import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  getStudyFor,
  StudyError,
  type StudyStatus,
  transitionStudy,
} from "../../../lib/objects/studies.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const to = ctx.url.searchParams.get("to") as StudyStatus | null;
    if (!to) throw new HttpError(400);
    try {
      await transitionStudy(db, {
        study: found.study,
        to,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof StudyError) throw new HttpError(409, err.message);
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}`, 303);
  },
});
