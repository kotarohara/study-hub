import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { ContactChannel, Participant } from "../../../lib/db/schema.ts";
import {
  CHANNEL_KINDS,
  type DuplicateWarning,
  findDuplicates,
  getParticipant,
  listChannels,
} from "../../../lib/objects/participants.ts";
import {
  listEnrollmentsOfParticipant,
  type ParticipationRow,
} from "../../../lib/objects/enrollments.ts";
import { audit } from "../../../lib/audit/log.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { Layout } from "../../../components/Layout.tsx";
import { DetailView } from "../../../components/ooui/DetailView.tsx";
import { StatusBadge } from "../../../components/ooui/StatusBadge.tsx";
import { resolveActions } from "../../../lib/ooui/actions.ts";

interface Data {
  participant: Participant;
  channels: ContactChannel[];
  /** Other pool entries sharing a contact value (never hard-blocked). */
  duplicates: DuplicateWarning[];
  history: ParticipationRow[];
  activeTab: string;
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "channels", label: "Channels" },
  { id: "history", label: "History" },
];

export const handler = define.handlers({
  async GET(ctx) {
    // Decrypted name/notes/channels: PII, so collaborators (limited
    // access, spec §3.10) are excluded — found by the 5.4 security review.
    if (!hasRole(ctx.state.member!.role, "assistant")) {
      throw new HttpError(403);
    }
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    const channels = await listChannels(db, participant.id);
    const activeTab = TABS.some((t) => t.id === ctx.url.searchParams.get("tab"))
      ? ctx.url.searchParams.get("tab")!
      : "overview";

    // Decrypted name/notes/channel values are on screen → PII view (spec §4).
    await audit(db, {
      action: "pii.view",
      actorId: ctx.state.member!.id,
      objectType: "participant",
      objectId: participant.id,
      details: { code: participant.code },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    return page<Data>({
      participant,
      channels,
      duplicates: await findDuplicates(
        db,
        channels.map((c) => ({ kind: c.kind, value: c.value })),
        participant.id,
      ),
      history: activeTab === "history"
        ? await listEnrollmentsOfParticipant(db, participant.id)
        : [],
      activeTab,
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { participant, channels } = data;
  const canManage = hasRole(me.role, "assistant");

  const actions = resolveActions(
    [
      {
        id: "edit",
        label: "Edit",
        href: `/participants/${participant.id}/edit`,
        method: "get",
        minRole: "assistant",
      },
      participant.doNotContact
        ? {
          id: "dnc-clear",
          label: "Allow contact again",
          href: `/participants/${participant.id}/dnc`,
          minRole: "assistant",
          confirm: `Clear the do-not-contact flag on ${participant.code}?`,
        }
        : {
          id: "dnc-set",
          label: "Mark do-not-contact",
          href: `/participants/${participant.id}/dnc`,
          tone: "danger",
          minRole: "assistant",
          confirm:
            `Mark ${participant.code} as do-not-contact? They will be excluded from recruitment and reminders.`,
        },
    ],
    { role: me.role },
  );

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="◉"
        typeLabel="Participant"
        title={`${participant.code} · ${participant.name}`}
        status={participant.doNotContact ? "do_not_contact" : undefined}
        properties={[
          { label: "Born", value: participant.yearOfBirth ?? "—" },
          { label: "Gender", value: participant.gender || "—" },
          { label: "Source", value: participant.source || "—" },
          {
            label: "Added",
            value: participant.createdAt.toISOString().slice(0, 10),
          },
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={`/participants/${participant.id}`}
        actions={actions}
      >
        {data.duplicates.length > 0 && (
          <div class="mb-4 rounded-card border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p class="font-medium">Possible duplicate records</p>
            <ul class="mt-1 list-inside list-disc">
              {data.duplicates.map((w) => (
                <li key={w.kind}>
                  The {w.kind} is also on {w.participantCodes.join(", ")}.
                </li>
              ))}
            </ul>
          </div>
        )}

        {data.activeTab === "overview" && (
          <p class="max-w-2xl whitespace-pre-wrap text-sm text-gray-700">
            {participant.notes || "No notes."}
          </p>
        )}

        {data.activeTab === "channels" && (
          <div class="max-w-2xl space-y-4">
            {channels.length === 0 && (
              <p class="text-sm text-gray-500">No contact channels.</p>
            )}
            {channels.length > 0 && (
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th class="py-2 pr-4">Kind</th>
                    <th class="py-2 pr-4">Value</th>
                    <th class="py-2 pr-4">Status</th>
                    <th class="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {channels.map((channel) => (
                    <tr key={channel.id} class="border-b border-gray-100">
                      <td class="py-2 pr-4">{channel.kind}</td>
                      <td class="py-2 pr-4 font-medium text-gray-900">
                        {channel.value}
                      </td>
                      <td class="py-2 pr-4">
                        <span class="inline-flex items-center gap-1">
                          {channel.isPreferred && (
                            <StatusBadge status="preferred" />
                          )}
                          {channel.verified && (
                            <StatusBadge status="verified" />
                          )}
                        </span>
                      </td>
                      <td class="py-2 text-right">
                        {canManage && (
                          <span class="inline-flex items-center gap-2">
                            {!channel.isPreferred && (
                              <form
                                method="post"
                                action={`/participants/${participant.id}/channels/prefer`}
                                class="inline"
                              >
                                <input
                                  type="hidden"
                                  name="channelId"
                                  value={channel.id}
                                />
                                <button
                                  type="submit"
                                  class="text-xs text-brand-700 hover:underline"
                                >
                                  Make preferred
                                </button>
                              </form>
                            )}
                            <form
                              method="post"
                              action={`/participants/${participant.id}/channels/remove`}
                              class="inline"
                              data-confirm={`Remove this ${channel.kind} channel? This deletes the stored value.`}
                            >
                              <input
                                type="hidden"
                                name="channelId"
                                value={channel.id}
                              />
                              <button
                                type="submit"
                                class="text-xs text-red-600 hover:underline"
                              >
                                Remove
                              </button>
                            </form>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {canManage && (
              <form
                method="post"
                action={`/participants/${participant.id}/channels/add`}
                class="flex items-center gap-2"
              >
                <select
                  name="kind"
                  class="rounded-card border border-gray-300 px-2 py-1.5 text-sm"
                >
                  {CHANNEL_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
                <input
                  type="text"
                  name="value"
                  required
                  placeholder="address / handle / chat id"
                  class="flex-1 rounded-card border border-gray-300 px-3 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Add channel
                </button>
              </form>
            )}

            {canManage && (
              <p class="text-sm text-gray-600">
                Connect Telegram for reminders:{" "}
                <a
                  href={`/participants/${participant.id}/telegram-link`}
                  class="text-brand-700 hover:underline"
                >
                  get a pairing link →
                </a>
              </p>
            )}
          </div>
        )}

        {data.activeTab === "history" && (
          data.history.length === 0
            ? (
              <p class="text-sm text-gray-500">
                No study participation yet.
              </p>
            )
            : (
              <table class="w-full max-w-2xl text-sm">
                <thead>
                  <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th class="py-2 pr-4">Study</th>
                    <th class="py-2 pr-4">Status</th>
                    <th class="py-2 pr-4">Enrolled</th>
                    <th class="py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((row) => (
                    <tr
                      key={row.enrollment.id}
                      class="border-b border-gray-100"
                    >
                      <td class="py-2 pr-4">
                        <a
                          href={`/studies/${row.studyId}?tab=participants`}
                          class="font-medium text-brand-700 hover:underline"
                        >
                          {row.studyName}
                        </a>
                        {row.enrollment.isPilot && (
                          <span class="ml-2">
                            <StatusBadge status="pilot" />
                          </span>
                        )}
                      </td>
                      <td class="py-2 pr-4">
                        <StatusBadge status={row.enrollment.status} />
                      </td>
                      <td class="py-2 pr-4">
                        {row.enrollment.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td class="py-2">
                        {row.enrollment.updatedAt.toISOString().slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        )}
      </DetailView>
    </Layout>
  );
});
