// Creates a dataset on a study (researcher+).
import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getStudyFor } from "../../../../lib/objects/studies.ts";
import {
  createDataset,
  DatasetError,
} from "../../../../lib/objects/datasets.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      await createDataset(db, {
        study: found.study,
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? ""),
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof DatasetError) throw new HttpError(400, err.message);
      throw err;
    }
    return ctx.redirect(`/studies/${found.study.id}?tab=data`, 303);
  },
});
