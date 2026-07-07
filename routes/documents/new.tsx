import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import type { Project, Study } from "../../lib/db/schema.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { getConfig } from "../../lib/config.ts";
import { createFileStores } from "../../lib/storage/filestore.ts";
import { getProjectFor } from "../../lib/objects/projects.ts";
import { getStudyFor } from "../../lib/objects/studies.ts";
import {
  createDocument,
  DOCUMENT_KINDS,
  DocumentError,
  documentFileKey,
  type DocumentKind,
  type NewVersionInput,
} from "../../lib/objects/documents.ts";
import {
  isTemplateKind,
  mergeFields,
  renderTemplate,
  STARTER_TEMPLATES,
} from "../../lib/objects/templates.ts";
import { listConditions } from "../../lib/objects/design.ts";
import { Layout } from "../../components/Layout.tsx";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface Data {
  project: Project;
  study: Study | null;
  error?: string;
  title?: string;
  prefilledContent?: string;
  prefilledKind?: string;
}

async function resolveTarget(
  ctx: { state: { member: import("../../lib/db/schema.ts").Member | null } },
  projectId: string,
  studyId: string,
): Promise<{ project: Project; study: Study | null }> {
  const db = getDb();
  const me = ctx.state.member!;
  if (studyId) {
    const found = await getStudyFor(db, me, studyId);
    if (!found) throw new HttpError(404);
    return { project: found.project, study: found.study };
  }
  const project = await getProjectFor(db, me, projectId);
  if (!project) throw new HttpError(404);
  return { project, study: null };
}

/** Builds the version input from the form: text content or file upload. */
export async function versionInputFromForm(
  form: FormData,
  storeFile: (fileName: string, bytes: Uint8Array) => Promise<string>,
): Promise<NewVersionInput> {
  const content = String(form.get("content") ?? "");
  const externalUrl = String(form.get("externalUrl") ?? "").trim();
  const file = form.get("file");
  const changeRationale = String(form.get("changeRationale") ?? "");

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new DocumentError("Uploads are limited to 10 MB.");
    }
    if (content.trim() || externalUrl) {
      throw new DocumentError(
        "Provide text content, a file, or a link — not several.",
      );
    }
    const fileKey = await storeFile(
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    return { fileKey, fileName: file.name, changeRationale };
  }
  // URL record (spec §5.5: e.g. a Notion page linked as a Document).
  if (externalUrl) return { externalUrl, changeRationale };
  return { content, changeRationale };
}

export const handler = define.handlers({
  async GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "researcher")) {
      throw new HttpError(403);
    }
    const target = await resolveTarget(
      ctx,
      ctx.url.searchParams.get("project") ?? "",
      ctx.url.searchParams.get("study") ?? "",
    );

    // Template prefill (spec §3.3): merge fields are resolved from the
    // study NOW, so the stored document text is concrete and never changes
    // silently when the design does.
    const template = ctx.url.searchParams.get("template") ?? "";
    let prefilledContent: string | undefined;
    let prefilledKind: string | undefined;
    if (target.study && isTemplateKind(template)) {
      const fields = mergeFields({
        study: target.study,
        project: target.project,
        conditions: await listConditions(getDb(), target.study.id),
      });
      prefilledContent = renderTemplate(STARTER_TEMPLATES[template], fields)
        .text;
      prefilledKind = template;
    }
    return page<Data>({ ...target, prefilledContent, prefilledKind });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();

    const form = await ctx.req.formData();
    const target = await resolveTarget(
      ctx,
      String(form.get("projectId") ?? ""),
      String(form.get("studyId") ?? ""),
    );

    const title = String(form.get("title") ?? "");
    const rawKind = String(form.get("kind") ?? "");
    if (!DOCUMENT_KINDS.includes(rawKind as DocumentKind)) {
      return page<Data>({ ...target, error: "Pick a document kind.", title }, {
        status: 400,
      });
    }

    try {
      // The id is not known before insert; key uploads by a fresh UUID.
      const uploadId = crypto.randomUUID();
      const initialVersion = await versionInputFromForm(
        form,
        async (name, bytes) => {
          const key = documentFileKey(uploadId, 1, name);
          await createFileStores(getConfig()).files.put(key, bytes);
          return key;
        },
      );
      const document = await createDocument(db, {
        project: target.project,
        study: target.study,
        title,
        kind: rawKind as DocumentKind,
        initialVersion,
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/documents/${document.id}`, 303);
    } catch (err) {
      if (err instanceof DocumentError) {
        return page<Data>({ ...target, error: err.message, title }, {
          status: 400,
        });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout
    member={state.member!}
    pathname={url.pathname}
    title={`New document in ${data.study?.name ?? data.project.name}`}
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
      <input type="hidden" name="projectId" value={data.project.id} />
      {data.study && (
        <input type="hidden" name="studyId" value={data.study.id} />
      )}
      {data.study && (
        <p class="text-xs text-gray-500">
          Start from a template (merge fields filled from the study design):
          {" "}
          <a
            href={`/documents/new?study=${data.study.id}&template=consent_form`}
            class="text-brand-700 hover:underline"
          >
            consent form
          </a>
          {" · "}
          <a
            href={`/documents/new?study=${data.study.id}&template=irb_protocol`}
            class="text-brand-700 hover:underline"
          >
            IRB protocol
          </a>
        </p>
      )}
      <label class="flex flex-col gap-1 text-sm">
        Title
        <input
          type="text"
          name="title"
          required
          value={data.title ?? ""}
          class="rounded-card border border-gray-300 px-3 py-2"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Kind
        <select
          name="kind"
          class="rounded-card border border-gray-300 px-3 py-2"
        >
          {DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k} selected={data.prefilledKind === k}>
              {k.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Text content
        <span class="text-xs text-gray-500">
          Written in-app — versions are diffable
        </span>
        <textarea
          name="content"
          rows={data.prefilledContent ? 16 : 8}
          class="rounded-card border border-gray-300 px-3 py-2"
        >
          {data.prefilledContent ?? ""}
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
        Create document
      </button>
    </form>
  </Layout>
));
