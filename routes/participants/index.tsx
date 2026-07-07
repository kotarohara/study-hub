import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import type { Participant } from "../../lib/db/schema.ts";
import {
  channelCounts,
  listParticipants,
} from "../../lib/objects/participants.ts";
import { audit } from "../../lib/audit/log.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
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
  result: CollectionResult<Participant>;
  channels: Record<string, number>;
}

export const handler = define.handlers({
  async GET(ctx) {
    // The pool shows decrypted names: PII, so collaborators (limited
    // access, spec §3.10) are excluded — found by the 5.4 security review.
    if (!hasRole(ctx.state.member!.role, "assistant")) {
      throw new HttpError(403);
    }
    const db = getDb();
    const all = await listParticipants(db);
    const result = applyCollection(
      all,
      parseCollectionParams(ctx.url.searchParams),
      {
        searchText: (p) => `${p.code} ${p.name} ${p.gender} ${p.source}`,
        sorters: {
          code: (a, b) => a.code.localeCompare(b.code),
          name: (a, b) => a.name.localeCompare(b.name),
          born: (a, b) => (a.yearOfBirth ?? 0) - (b.yearOfBirth ?? 0),
          added: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        },
        defaultSort: "code",
      },
    );
    const counts = await channelCounts(db, result.rows.map((p) => p.id));

    // The pool listing shows decrypted names → it is a PII view (spec §4),
    // audited at the handler (not middleware) so the count is accurate.
    await audit(db, {
      action: "pii.list_viewed",
      actorId: ctx.state.member!.id,
      objectType: "participant",
      details: { count: result.rows.length },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    return page<Data>({
      result,
      channels: Object.fromEntries(counts),
    });
  },
});

const COLUMNS: Column<Participant>[] = [
  { id: "code", label: "Code", sortable: true, render: (p) => p.code },
  {
    id: "name",
    label: "Name",
    sortable: true,
    render: (p) => (
      <span class="inline-flex items-center gap-2">
        {p.name}
        {p.doNotContact && <StatusBadge status="do_not_contact" />}
      </span>
    ),
  },
  {
    id: "born",
    label: "Born",
    sortable: true,
    render: (p) => p.yearOfBirth ?? "—",
  },
  { id: "gender", label: "Gender", render: (p) => p.gender || "—" },
  { id: "source", label: "Source", render: (p) => p.source || "—" },
  {
    id: "added",
    label: "Added",
    sortable: true,
    render: (p) => p.createdAt.toISOString().slice(0, 10),
  },
];

export default define.page<typeof handler>(({ data, state, url }) => {
  const columns: Column<Participant>[] = [
    ...COLUMNS,
    {
      id: "channels",
      label: "Channels",
      render: (p) => data.channels[p.id] ?? 0,
    },
  ];

  const toolbar = (
    <ActionBar
      actions={resolveActions(
        [
          {
            id: "new",
            label: "Add participant",
            href: "/participants/new",
            method: "get",
            tone: "primary",
            minRole: "assistant",
          },
        ],
        { role: state.member!.role },
      )}
    />
  );

  return (
    <Layout
      member={state.member!}
      pathname={url.pathname}
      title="Participants"
    >
      <CollectionView
        baseHref="/participants"
        columns={columns}
        result={data.result}
        rowId={(p) => p.id}
        rowHref={(p) => `/participants/${p.id}`}
        searchPlaceholder="Filter by code, name, gender, source…"
        emptyMessage="No participants yet — the pool is shared across all studies."
        toolbar={toolbar}
      />
    </Layout>
  );
});
