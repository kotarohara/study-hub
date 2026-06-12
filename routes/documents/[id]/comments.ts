import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import {
  addComment,
  DocumentError,
  getDocumentFor,
} from "../../../lib/objects/documents.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    // Collaborators are read-only (spec §3.10); assistants may comment.
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getDocumentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      await addComment(db, {
        document: found.document,
        author: me,
        body: String(form.get("body") ?? ""),
        versionNumber: found.document.currentVersion,
      });
    } catch (err) {
      if (err instanceof DocumentError) throw new HttpError(400, err.message);
      throw err;
    }
    return ctx.redirect(`/documents/${found.document.id}?tab=comments`, 303);
  },
});
