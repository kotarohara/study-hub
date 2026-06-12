import { page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import {
  listStudiesFor,
  type StudyWithProject,
} from "../../lib/objects/studies.ts";
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

interface Data {
  result: CollectionResult<StudyWithProject>;
}

export const handler = define.handlers({
  async GET(ctx) {
    const visible = await listStudiesFor(getDb(), ctx.state.member!);
    const result = applyCollection(
      visible,
      parseCollectionParams(ctx.url.searchParams),
      {
        searchText: (r) =>
          `${r.study.name} ${r.project.name} ${r.study.methodology} ${r.study.status}`,
        sorters: {
          name: (a, b) => a.study.name.localeCompare(b.study.name),
          project: (a, b) => a.project.name.localeCompare(b.project.name),
          methodology: (a, b) =>
            a.study.methodology.localeCompare(b.study.methodology),
          status: (a, b) => a.study.status.localeCompare(b.study.status),
        },
        defaultSort: "name",
      },
    );
    return page<Data>({ result });
  },
});

const COLUMNS: Column<StudyWithProject>[] = [
  {
    id: "name",
    label: "Name",
    sortable: true,
    // The pilot badge follows the study onto every view (spec §3.3).
    render: (r) => (
      <>
        {r.study.name}
        {r.study.oversightPathway === "internal_pilot" && (
          <>
            {" "}
            <StatusBadge status="pilot" />
          </>
        )}
      </>
    ),
  },
  {
    id: "project",
    label: "Project",
    sortable: true,
    render: (r) => r.project.name,
  },
  {
    id: "methodology",
    label: "Methodology",
    sortable: true,
    render: (r) => r.study.methodology.replaceAll("_", " "),
  },
  {
    id: "status",
    label: "Status",
    sortable: true,
    render: (r) => <StatusBadge status={r.study.status} />,
  },
];

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Studies">
    <CollectionView
      baseHref="/studies"
      columns={COLUMNS}
      result={data.result}
      rowId={(r) =>
        r.study.id}
      rowHref={(r) =>
        `/studies/${r.study.id}`}
      searchPlaceholder="Filter studies…"
      emptyMessage="No studies yet. Create one from a project's Studies tab."
    />
  </Layout>
));
