import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  DocumentError,
  type DocumentStatus,
  getDocumentFor,
  transitionDocument,
} from "../../../lib/objects/documents.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getDocumentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const to = ctx.url.searchParams.get("to") as DocumentStatus | null;
    if (!to) throw new HttpError(400);
    try {
      await transitionDocument(db, {
        document: found.document,
        to,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof DocumentError) throw new HttpError(409, err.message);
      throw err;
    }
    return ctx.redirect(`/documents/${found.document.id}`, 303);
  },
});
