// Uploads a data file onto a dataset (assistant+): bytes go to the
// FileStore (MinIO locally, S3 in production), the row is recorded and
// audited.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { getConfig } from "../../../lib/config.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { createFileStores } from "../../../lib/storage/filestore.ts";
import {
  addDatasetFile,
  datasetFileKey,
} from "../../../lib/objects/datasets.ts";
import { getDatasetFor } from "./_shared.ts";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getDatasetFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new HttpError(400, "Pick a file to upload.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(400, "File exceeds the 50 MB upload limit.");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const key = datasetFileKey(found.dataset.id, file.name);
    await createFileStores(getConfig()).files.put(key, bytes, {
      contentType: file.type || undefined,
    });
    await addDatasetFile(db, {
      dataset: found.dataset,
      fileKey: key,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      uploadedBy: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect(`/datasets/${found.dataset.id}`, 303);
  },
});
