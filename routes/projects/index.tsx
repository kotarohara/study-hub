import { page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import type { Project } from "../../lib/db/schema.ts";
import { listProjectsFor } from "../../lib/objects/projects.ts";
import { Layout } from "../../components/Layout.tsx";
import {
  CollectionView,
  type Column,
} from "../../components/ooui/CollectionView.tsx";
import { StatusBadge } from "../../components/ooui/StatusBadge.tsx";
import { ActionBar } from "../../components/ooui/ActionBar.tsx";
import {
  applyCollection,
  type CollectionResult,
  parseCollectionParams,
} from "../../lib/ooui/collection.ts";
import { resolveActions } from "../../lib/ooui/actions.ts";

interface Data {
  result: CollectionResult<Project>;
}

export const handler = define.handlers({
  async GET(ctx) {
    const visible = await listProjectsFor(getDb(), ctx.state.member!);
    const result = applyCollection(
      visible,
      parseCollectionParams(ctx.url.searchParams),
      {
        searchText: (p) => `${p.name} ${p.description} ${p.status}`,
        sorters: {
          name: (a, b) => a.name.localeCompare(b.name),
          status: (a, b) => a.status.localeCompare(b.status),
          created: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        },
        defaultSort: "name",
      },
    );
    return page<Data>({ result });
  },
});

const COLUMNS: Column<Project>[] = [
  { id: "name", label: "Name", sortable: true, render: (p) => p.name },
  {
    id: "status",
    label: "Status",
    sortable: true,
    render: (p) => <StatusBadge status={p.status} />,
  },
  {
    id: "created",
    label: "Created",
    sortable: true,
    render: (p) => p.createdAt.toISOString().slice(0, 10),
  },
];

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Projects">
    <CollectionView
      baseHref="/projects"
      columns={COLUMNS}
      result={data.result}
      rowId={(p) =>
        p.id}
      rowHref={(p) =>
        `/projects/${p.id}`}
      searchPlaceholder="Filter projects…"
      emptyMessage="No projects yet. Create one to get started."
      toolbar={
        <ActionBar
          actions={resolveActions(
            [
              {
                id: "new",
                label: "New project",
                href: "/projects/new",
                method: "get",
                tone: "primary",
                minRole: "researcher",
              },
            ],
            { role: state.member!.role },
          )}
        />
      }
    />
  </Layout>
));
