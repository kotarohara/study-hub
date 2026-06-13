import { page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import type { Instrument } from "../../lib/db/schema.ts";
import { listInstruments } from "../../lib/objects/instruments.ts";
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
  result: CollectionResult<Instrument>;
}

export const handler = define.handlers({
  async GET(ctx) {
    const all = await listInstruments(getDb());
    const result = applyCollection(
      all,
      parseCollectionParams(ctx.url.searchParams),
      {
        searchText: (i) => `${i.name} ${i.kind} ${i.purpose}`,
        sorters: {
          name: (a, b) => a.name.localeCompare(b.name),
          kind: (a, b) => a.kind.localeCompare(b.kind),
          purpose: (a, b) => a.purpose.localeCompare(b.purpose),
          updated: (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
        },
        // No default sort: listInstruments already returns newest first.
      },
    );
    return page<Data>({ result });
  },
});

const COLUMNS: Column<Instrument>[] = [
  { id: "name", label: "Name", sortable: true, render: (i) => i.name },
  {
    id: "kind",
    label: "Kind",
    sortable: true,
    render: (i) => <StatusBadge status={i.kind} />,
  },
  {
    id: "purpose",
    label: "Purpose",
    sortable: true,
    render: (i) => i.purpose.replaceAll("_", " "),
  },
  { id: "version", label: "Version", render: (i) => `v${i.currentVersion}` },
  {
    id: "updated",
    label: "Updated",
    sortable: true,
    render: (i) => i.updatedAt.toISOString().slice(0, 10),
  },
];

export default define.page<typeof handler>(({ data, state, url }) => {
  const toolbar = (
    <ActionBar
      actions={resolveActions(
        [
          {
            id: "new",
            label: "New instrument",
            href: "/instruments/new",
            method: "get",
            tone: "primary",
            minRole: "researcher",
          },
        ],
        { role: state.member!.role },
      )}
    />
  );

  return (
    <Layout member={state.member!} pathname={url.pathname} title="Instruments">
      <CollectionView
        baseHref="/instruments"
        columns={COLUMNS}
        result={data.result}
        rowId={(i) =>
          i.id}
        rowHref={(i) =>
          `/instruments/${i.id}`}
        searchPlaceholder="Filter by name, kind, purpose…"
        emptyMessage="No instruments yet — simple forms and external records live here, reusable across studies."
        toolbar={toolbar}
      />
    </Layout>
  );
});
