import { HttpError, page } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import type { Document, DocumentVersion } from "../../../../lib/db/schema.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import { getConfig } from "../../../../lib/config.ts";
import { createFileStores } from "../../../../lib/storage/filestore.ts";
import {
  addVersion,
  DocumentError,
  documentFileKey,
  getDocumentFor,
  getVersion,
} from "../../../../lib/objects/documents.ts";
import { versionInputFromForm } from "../../new.tsx";
import { Layout } from "../../../../components/Layout.tsx";

interface Data {
  document: Document;
  current: DocumentVersion | null;
  error?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getDocumentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);
    return page<Data>({
      document: found.document,
      current: await getVersion(
        db,
        found.document.id,
        found.document.currentVersion,
      ),
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getDocumentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      const next = found.document.currentVersion + 1;
      const version = await versionInputFromForm(form, async (name, bytes) => {
        const key = documentFileKey(found.document.id, next, name);
        await createFileStores(getConfig()).files.put(key, bytes);
        return key;
      });
      await addVersion(db, {
        document: found.document,
        version,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/documents/${found.document.id}?tab=versions`, 303);
    } catch (err) {
      if (err instanceof DocumentError) {
        return page<Data>(
          {
            document: found.document,
            current: await getVersion(
              db,
              found.document.id,
              found.document.currentVersion,
            ),
            error: err.message,
          },
          { status: 400 },
        );
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout
    member={state.member!}
    pathname={url.pathname}
    title={`New version of ${data.document.title}`}
  >
    <form
      method="post"
      enctype="multipart/form-data"
      class="max-w-lg space-y-4 rounded-card border border-gray-200 bg-white p-4"
    >
      {data.error && (
        <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {data.error}
        </p>
      )}
      <p class="text-sm text-gray-600">
        This creates v{data.document.currentVersion + 1}{" "}
        and resets the review status to <strong>draft</strong>{" "}
        — a revision is never implicitly approved.
      </p>
      <label class="flex flex-col gap-1 text-sm">
        Change rationale (required)
        <input
          type="text"
          name="changeRationale"
          required
          placeholder="e.g. IRB amendment: added remote participation"
          class="rounded-card border border-gray-300 px-3 py-2"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Text content
        <textarea
          name="content"
          rows={10}
          class="rounded-card border border-gray-300 px-3 py-2"
        >
          {data.current?.content ?? ""}
        </textarea>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        … or upload a file (max 10 MB)
        <input type="file" name="file" class="text-sm" />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        … or link an external page (e.g. a Notion page)
        <input
          type="url"
          name="externalUrl"
          placeholder="https://www.notion.so/…"
          class="max-w-md rounded-card border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <button
        type="submit"
        class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Add version
      </button>
    </form>
  </Layout>
));
