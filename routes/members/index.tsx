import { page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { type Member, members } from "../../lib/db/schema.ts";
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
  result: CollectionResult<Member>;
}

export const handler = define.handlers({
  async GET(ctx) {
    const all = await getDb().select().from(members);
    const result = applyCollection(
      all,
      parseCollectionParams(ctx.url.searchParams),
      {
        searchText: (m) => `${m.name} ${m.email} ${m.role}`,
        sorters: {
          name: (a, b) => a.name.localeCompare(b.name),
          email: (a, b) => a.email.localeCompare(b.email),
          role: (a, b) => a.role.localeCompare(b.role),
          joined: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        },
        defaultSort: "name",
      },
    );
    return page<Data>({ result });
  },
});

const COLUMNS: Column<Member>[] = [
  { id: "name", label: "Name", sortable: true, render: (m) => m.name },
  { id: "email", label: "Email", sortable: true, render: (m) => m.email },
  {
    id: "role",
    label: "Role",
    sortable: true,
    render: (m) => <StatusBadge status={m.role} />,
  },
  {
    id: "joined",
    label: "Joined",
    sortable: true,
    render: (m) => m.createdAt.toISOString().slice(0, 10),
  },
];

export default define.page<typeof handler>(({ data, state, url }) => {
  const toolbar = (
    <ActionBar
      actions={resolveActions(
        [
          {
            id: "invite",
            label: "Invite member",
            href: "/members/invite",
            method: "get",
            tone: "primary",
            minRole: "pi",
          },
        ],
        { role: state.member!.role },
      )}
    />
  );

  return (
    <Layout member={state.member!} pathname={url.pathname} title="Members">
      <CollectionView
        baseHref="/members"
        columns={COLUMNS}
        result={data.result}
        rowId={(m) => m.id}
        rowHref={(m) => `/members/${m.id}`}
        searchPlaceholder="Filter by name, email, role…"
        emptyMessage="No members match."
        toolbar={toolbar}
      />
    </Layout>
  );
});
