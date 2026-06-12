import { HttpError, page } from "fresh";
import { desc, eq } from "drizzle-orm";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import {
  type AuditEntry,
  auditLog,
  type Member,
  members,
} from "../../lib/db/schema.ts";
import { Layout } from "../../components/Layout.tsx";
import { DetailView } from "../../components/ooui/DetailView.tsx";
import { resolveActions } from "../../lib/ooui/actions.ts";

interface Data {
  subject: Member;
  activeTab: string;
  activity: AuditEntry[];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
];

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const subject = await db.query.members.findFirst({
      where: eq(members.id, ctx.params.id),
    });
    if (!subject) throw new HttpError(404);

    const activeTab = TABS.some((t) => t.id === ctx.url.searchParams.get("tab"))
      ? ctx.url.searchParams.get("tab")!
      : "overview";

    const activity = activeTab === "activity"
      ? await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.actorId, subject.id))
        .orderBy(desc(auditLog.at))
        .limit(20)
      : [];

    return page<Data>({ subject, activeTab, activity });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { subject } = data;
  const isSelf = me.id === subject.id;

  const actions = resolveActions(
    [
      {
        id: "revoke-sessions",
        label: isSelf ? "Sign out everywhere" : "Revoke sessions",
        href: `/members/${subject.id}/revoke-sessions`,
        tone: "danger",
        // PI can revoke anyone; everyone can revoke their own.
        minRole: isSelf ? undefined : "pi",
        confirm: isSelf
          ? "Sign out of all devices, including this one?"
          : `Sign ${subject.name} out of all devices?`,
      },
    ],
    { role: me.role },
  );

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="♟"
        typeLabel="Member"
        title={subject.name}
        status={subject.role}
        properties={[
          { label: "Email", value: subject.email },
          { label: "Role", value: subject.role },
          {
            label: "Joined",
            value: subject.createdAt.toISOString().slice(0, 10),
          },
          {
            label: "Account",
            value: subject.passwordHash ? "active" : "invite pending",
          },
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={`/members/${subject.id}`}
        actions={actions}
      >
        {data.activeTab === "overview"
          ? (
            <p class="text-sm text-gray-600">
              Projects and studies this member belongs to will appear here
              (Phase 1).
            </p>
          )
          : data.activity.length === 0
          ? <p class="text-sm text-gray-500">No recorded activity.</p>
          : (
            <ul class="space-y-1 text-sm">
              {data.activity.map((entry) => (
                <li class="flex gap-3 rounded-card border border-gray-100 bg-white px-3 py-2">
                  <span class="text-gray-500">
                    {entry.at.toISOString().replace("T", " ").slice(0, 16)}
                  </span>
                  <span class="font-medium text-gray-900">{entry.action}</span>
                  {entry.objectType && (
                    <span class="text-gray-500">
                      {entry.objectType} {entry.objectId}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
      </DetailView>
    </Layout>
  );
});
