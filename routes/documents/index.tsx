import { page } from "fresh";
import { inArray } from "drizzle-orm";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { type Document, documents, type Project } from "../../lib/db/schema.ts";
import { listProjectsFor } from "../../lib/objects/projects.ts";
import { Layout } from "../../components/Layout.tsx";
import {
  CollectionView,
  type Column,
} from "../../components/ooui/CollectionView.tsx";
import { StatusBadge } from "../../components/ooui/StatusBadge.tsx";
import {
  applyCollection,
  type CollectionResult,
  parseCollectionParams,
} from "../../lib/ooui/collection.ts";

interface Row {
  document: Document;
  project: Project;
}

interface Data {
  result: CollectionResult<Row>;
}

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const visibleProjects = await listProjectsFor(db, ctx.state.member!);
    const byId = new Map(visibleProjects.map((p) => [p.id, p]));
    const rows = byId.size === 0 ? [] : await db
      .select()
      .from(documents)
      .where(inArray(documents.projectId, [...byId.keys()]));
    const result = applyCollection(
      rows.map((document) => ({
        document,
        project: byId.get(document.projectId)!,
      })),
      parseCollectionParams(ctx.url.searchParams),
      {
        searchText: (r) =>
          `${r.document.title} ${r.document.kind} ${r.project.name} ${r.document.reviewStatus}`,
        sorters: {
          title: (a, b) => a.document.title.localeCompare(b.document.title),
          kind: (a, b) => a.document.kind.localeCompare(b.document.kind),
          project: (a, b) => a.project.name.localeCompare(b.project.name),
          status: (a, b) =>
            a.document.reviewStatus.localeCompare(b.document.reviewStatus),
        },
        defaultSort: "title",
      },
    );
    return page<Data>({ result });
  },
});

const COLUMNS: Column<Row>[] = [
  {
    id: "title",
    label: "Title",
    sortable: true,
    render: (r) => r.document.title,
  },
  {
    id: "kind",
    label: "Kind",
    sortable: true,
    render: (r) => r.document.kind.replaceAll("_", " "),
  },
  {
    id: "project",
    label: "Project",
    sortable: true,
    render: (r) => r.project.name,
  },
  {
    id: "status",
    label: "Status",
    sortable: true,
    render: (r) => <StatusBadge status={r.document.reviewStatus} />,
  },
  {
    id: "version",
    label: "Version",
    render: (r) => `v${r.document.currentVersion}`,
  },
];

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Documents">
    <CollectionView
      baseHref="/documents"
      columns={COLUMNS}
      result={data.result}
      rowId={(r) =>
        r.document.id}
      rowHref={(r) =>
        `/documents/${r.document.id}`}
      searchPlaceholder="Filter documents…"
      emptyMessage="No documents yet. Create one from a project or study."
    />
  </Layout>
));
