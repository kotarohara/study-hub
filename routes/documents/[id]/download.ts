// Redirects to a short-lived presigned URL for an uploaded version file.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { getConfig } from "../../../lib/config.ts";
import { createFileStores } from "../../../lib/storage/filestore.ts";
import { getDocumentFor, getVersion } from "../../../lib/objects/documents.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getDocumentFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);

    const versionNumber = Number(ctx.url.searchParams.get("v"));
    const version = Number.isInteger(versionNumber)
      ? await getVersion(db, found.document.id, versionNumber)
      : null;
    if (!version?.fileKey) throw new HttpError(404);

    const url = await createFileStores(getConfig()).files.presignGet(
      version.fileKey,
      { expiresInSeconds: 5 * 60 },
    );
    return ctx.redirect(url, 302);
  },
});
