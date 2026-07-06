// Downloads a dataset file via a short-lived presigned URL. Audited: a
// data-file download is an export-shaped action (spec §4).
import { HttpError } from "fresh";
import { define } from "../../../../../utils.ts";
import { getDb } from "../../../../../lib/db/client.ts";
import { getConfig } from "../../../../../lib/config.ts";
import { clientHost } from "../../../../../lib/auth/limiters.ts";
import { audit } from "../../../../../lib/audit/log.ts";
import { createFileStores } from "../../../../../lib/storage/filestore.ts";
import { getDatasetFile } from "../../../../../lib/objects/datasets.ts";
import { getDatasetFor } from "../../_shared.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    const db = getDb();
    const found = await getDatasetFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);
    const file = await getDatasetFile(db, found.dataset.id, ctx.params.fileId);
    if (!file) throw new HttpError(404);

    await audit(db, {
      action: "dataset.file_downloaded",
      actorId: me.id,
      objectType: "dataset",
      objectId: found.dataset.id,
      details: { fileName: file.fileName },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    const url = await createFileStores(getConfig()).files.presignGet(
      file.fileKey,
      { expiresInSeconds: 300 },
    );
    return ctx.redirect(url, 302);
  },
});
