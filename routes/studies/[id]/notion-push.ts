// "Push to Notion" (spec §5.5, researcher+): one-way study snapshot to the
// lab Notion database. Study-level fields only — never PII.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../lib/objects/studies.ts";
import { pushStudyToNotion } from "../../../lib/objects/notion_push.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const result = await pushStudyToNotion(db, {
      study: found.study,
      actor: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    if (!result.ok) {
      throw new HttpError(502, result.error ?? "Notion push failed.");
    }
    return ctx.redirect(`/studies/${found.study.id}`, 303);
  },
});
