import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type {
  Document,
  DocumentComment,
  DocumentVersion,
  Member,
  Project,
} from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import {
  allowedDocumentTransitions,
  type DocumentStatus,
  getDocumentFor,
  getVersion,
  listComments,
  listVersions,
} from "../../../lib/objects/documents.ts";
import { Layout } from "../../../components/Layout.tsx";
import { DetailView } from "../../../components/ooui/DetailView.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";
import { resolveActions } from "../../../lib/ooui/actions.ts";

interface Data {
  document: Document;
  project: Project;
  activeTab: string;
  current: DocumentVersion | null;
  versions: DocumentVersion[];
  comments: { comment: DocumentComment; author: Member }[];
}

const TABS = [
  { id: "content", label: "Content" },
  { id: "versions", label: "Versions" },
  { id: "comments", label: "Comments" },
];

const TRANSITION_LABELS: Partial<Record<DocumentStatus, string>> = {
  internal_review: "Send to internal review",
  submitted: "Mark as submitted",
  approved: "Record approval",
  revisions_requested: "Request revisions",
  draft: "Back to draft",
};

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getDocumentFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);

    const activeTab = TABS.some((t) => t.id === ctx.url.searchParams.get("tab"))
      ? ctx.url.searchParams.get("tab")!
      : "content";

    return page<Data>({
      ...found,
      activeTab,
      current: await getVersion(
        db,
        found.document.id,
        found.document.currentVersion,
      ),
      versions: activeTab === "versions"
        ? await listVersions(db, found.document.id)
        : [],
      comments: activeTab === "comments"
        ? await listComments(db, found.document.id)
        : [],
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { document } = data;
  const base = `/documents/${document.id}`;

  const actions = resolveActions(
    [
      ...allowedDocumentTransitions(document.reviewStatus).map((to) => ({
        id: `to-${to}`,
        label: TRANSITION_LABELS[to] ?? to,
        href: `${base}/transition?to=${to}`,
        tone: to === "approved" ? "primary" as const : "default" as const,
        // Recording approval is PI-only; other moves are researcher+.
        minRole: to === "approved" ? "pi" as const : "researcher" as const,
        ...(to === "approved"
          ? { confirm: "Record IRB approval for the current version?" }
          : {}),
      })),
      {
        id: "new-version",
        label: "New version",
        href: `${base}/versions/new`,
        method: "get" as const,
        minRole: "researcher" as const,
      },
    ],
    { status: document.reviewStatus, role: me.role },
  );

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="▤"
        typeLabel="Document"
        title={document.title}
        status={document.reviewStatus}
        properties={[
          {
            label: "Project",
            value: (
              <Chip
                href={`/projects/${data.project.id}`}
                icon="▣"
                label={data.project.name}
              />
            ),
          },
          { label: "Kind", value: document.kind.replaceAll("_", " ") },
          { label: "Version", value: `v${document.currentVersion}` },
          {
            label: "Updated",
            value: document.updatedAt.toISOString().slice(0, 10),
          },
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={base}
        actions={actions}
      >
        {data.activeTab === "content" && (
          data.current?.content
            ? (
              <pre class="max-w-3xl whitespace-pre-wrap rounded-card border border-gray-200 bg-white p-4 font-sans text-sm text-gray-900">
                {data.current.content}
              </pre>
            )
            : data.current?.fileKey
            ? (
              <p class="text-sm">
                Uploaded file:{" "}
                <a
                  href={`${base}/download?v=${document.currentVersion}`}
                  class="text-brand-700 hover:underline"
                >
                  {data.current.fileName ?? "download"}
                </a>
              </p>
            )
            : data.current?.externalUrl
            ? (
              <p class="text-sm">
                Linked page:{" "}
                <a
                  href={data.current.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="break-all text-brand-700 hover:underline"
                >
                  {data.current.externalUrl}
                </a>
              </p>
            )
            : <p class="text-sm text-gray-500">No content.</p>
        )}

        {data.activeTab === "versions" && (
          <ul class="max-w-3xl space-y-2">
            {data.versions.map((v) => (
              <li
                key={v.id}
                class="flex flex-wrap items-center gap-3 rounded-card border border-gray-200 bg-white px-3 py-2 text-sm"
              >
                <span class="font-medium">v{v.versionNumber}</span>
                <span class="text-gray-500">
                  {v.createdAt.toISOString().slice(0, 10)}
                </span>
                {v.changeRationale && (
                  <span class="text-gray-600">“{v.changeRationale}”</span>
                )}
                <span class="ml-auto flex gap-3">
                  {v.fileKey && (
                    <a
                      href={`${base}/download?v=${v.versionNumber}`}
                      class="text-brand-700 hover:underline"
                    >
                      download
                    </a>
                  )}
                  {v.content !== null && v.versionNumber > 1 && (
                    <a
                      href={`${base}/diff?from=${
                        v.versionNumber - 1
                      }&to=${v.versionNumber}`}
                      class="text-brand-700 hover:underline"
                    >
                      diff v{v.versionNumber - 1} → v{v.versionNumber}
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {data.activeTab === "comments" && (
          <div class="max-w-3xl space-y-4">
            <ul class="space-y-2">
              {data.comments.length === 0 && (
                <p class="text-sm text-gray-500">No comments yet.</p>
              )}
              {data.comments.map(({ comment, author }) => (
                <li
                  key={comment.id}
                  class="rounded-card border border-gray-200 bg-white px-3 py-2 text-sm"
                >
                  <p class="text-xs text-gray-500">
                    <span class="font-medium text-gray-700">{author.name}</span>
                    {" · "}
                    {comment.createdAt.toISOString().replace("T", " ").slice(
                      0,
                      16,
                    )}
                    {comment.versionNumber !== null &&
                      ` · on v${comment.versionNumber}`}
                  </p>
                  <p class="mt-1 whitespace-pre-wrap text-gray-900">
                    {comment.body}
                  </p>
                </li>
              ))}
            </ul>
            {hasRole(me.role, "assistant") && (
              <form method="post" action={`${base}/comments`} class="space-y-2">
                <textarea
                  name="body"
                  rows={3}
                  required
                  placeholder="Reviewer comment…"
                  class="w-full rounded-card border border-gray-300 px-3 py-2 text-sm"
                >
                </textarea>
                <button
                  type="submit"
                  class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Comment on v{document.currentVersion}
                </button>
              </form>
            )}
          </div>
        )}
      </DetailView>
    </Layout>
  );
});
