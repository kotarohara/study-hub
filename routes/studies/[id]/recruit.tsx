// Re-recruitment page (spec §3.4): filter the pool, pick people, bulk-
// invite them into this study. Inviting creates screened enrollments and
// shows a run sheet of preferred channels for manual sending (automated
// delivery arrives with messaging, Phase 3). Names and channel values are
// PII — both views are audited at this handler.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";
import type { Study } from "../../../lib/db/schema.ts";
import { getStudyFor } from "../../../lib/objects/studies.ts";
import {
  bulkInvite,
  type BulkInviteResult,
  filterPool,
  type PoolFilter,
  type PoolMatch,
} from "../../../lib/objects/recruitment.ts";
import {
  getScreenerOfStudy,
  isScreenerLive,
  screenerUrl,
} from "../../../lib/objects/screeners.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";
import { StatusBadge } from "../../../components/ooui/StatusBadge.tsx";

interface Data {
  study: Study;
  filter: PoolFilter;
  matches: PoolMatch[];
  /** Set after a POST: the run sheet to send manually. */
  result: BulkInviteResult | null;
  screenerLink: string | null;
}

function parseFilter(sp: URLSearchParams): PoolFilter {
  const num = (key: string) => {
    const value = Number(sp.get(key));
    return sp.get(key)?.trim() && Number.isInteger(value) ? value : null;
  };
  return {
    gender: sp.get("gender")?.trim() ?? "",
    source: sp.get("source")?.trim() ?? "",
    minBirthYear: num("minYear"),
    maxBirthYear: num("maxYear"),
    // Default ON (compliance-safe); an explicit submit can turn it off.
    requireRecontact: sp.get("filtered") === "1"
      ? sp.get("recontact") === "1"
      : true,
  };
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const filter = parseFilter(ctx.url.searchParams);
    const matches = await filterPool(db, found.study, filter);
    if (matches.length > 0) {
      // The match list shows decrypted names → PII view (spec §4).
      await audit(db, {
        action: "pii.list_viewed",
        actorId: me.id,
        objectType: "participant",
        details: { count: matches.length, via: "re_recruit" },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    }
    return page<Data>({
      study: found.study,
      filter,
      matches,
      result: null,
      screenerLink: null,
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const ids = form.getAll("ids").map(String).filter(Boolean);
    const result = await bulkInvite(db, {
      study: found.study,
      participantIds: ids,
      actor: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    if (result.invited.length > 0) {
      // The run sheet shows decrypted channel values → PII view.
      await audit(db, {
        action: "pii.view",
        actorId: me.id,
        objectType: "participant",
        details: {
          count: result.invited.length,
          via: "invite_sheet",
          codes: result.invited.map((row) => row.participant.code),
        },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    }
    const screener = await getScreenerOfStudy(db, found.study.id);
    return page<Data>({
      study: found.study,
      filter: parseFilter(new URLSearchParams()),
      matches: [],
      result,
      screenerLink: screener && isScreenerLive(screener, found.study)
        ? screenerUrl(screener)
        : null,
    });
  },
});

const INPUT_CLASS = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { study, filter, result } = data;

  return (
    <Layout
      member={me}
      pathname={url.pathname}
      title={`Re-recruit — ${study.name}`}
    >
      <div class="mb-4">
        <Chip
          href={`/studies/${study.id}?tab=recruitment`}
          icon="⚗"
          label={study.name}
          status={study.status}
        />
      </div>

      {result
        ? (
          <div class="max-w-3xl space-y-6">
            <section class="space-y-2 rounded-card border border-gray-200 bg-white p-4">
              <h2 class="text-sm font-semibold text-gray-900">
                Invite run sheet — {result.invited.length}{" "}
                enrolled as “screened”
              </h2>
              <p class="text-sm text-gray-600">
                Contact each person via their preferred channel below.
                {data.screenerLink
                  ? " Suggested link to include:"
                  : " (No live screener page — share study details directly.)"}
              </p>
              {data.screenerLink && (
                <code class="block break-all rounded bg-gray-50 p-2 text-xs">
                  {data.screenerLink}
                </code>
              )}
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th class="py-2 pr-4">Code</th>
                    <th class="py-2 pr-4">Name</th>
                    <th class="py-2 pr-4">Channel</th>
                    <th class="py-2">Address / handle</th>
                  </tr>
                </thead>
                <tbody>
                  {result.invited.map((row) => (
                    <tr
                      key={row.participant.id}
                      class="border-b border-gray-100"
                    >
                      <td class="py-2 pr-4">
                        <a
                          href={`/participants/${row.participant.id}`}
                          class="font-medium text-brand-700 hover:underline"
                        >
                          {row.participant.code}
                        </a>
                      </td>
                      <td class="py-2 pr-4">{row.participant.name}</td>
                      <td class="py-2 pr-4">{row.channel?.kind ?? "—"}</td>
                      <td class="py-2 font-medium">
                        {row.channel?.value ?? "no contact channel!"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {result.skipped.length > 0 && (
              <section class="rounded-card border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p class="font-medium">Skipped</p>
                <ul class="mt-1 list-inside list-disc">
                  {result.skipped.map((row) => (
                    <li key={row.code}>
                      {row.code}: {row.reason}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <a
              href={`/studies/${study.id}?tab=participants`}
              class="text-sm text-brand-700 hover:underline"
            >
              Go to the Participants tab →
            </a>
          </div>
        )
        : (
          <div class="max-w-3xl space-y-6">
            <form
              method="get"
              class="flex flex-wrap items-end gap-3 rounded-card border border-gray-200 bg-white p-4"
            >
              <input type="hidden" name="filtered" value="1" />
              <label class="flex flex-col gap-1 text-sm">
                Gender
                <input
                  type="text"
                  name="gender"
                  value={filter.gender ?? ""}
                  class={INPUT_CLASS}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Born after
                <input
                  type="number"
                  name="minYear"
                  value={filter.minBirthYear ?? ""}
                  class={`w-24 ${INPUT_CLASS}`}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Born before
                <input
                  type="number"
                  name="maxYear"
                  value={filter.maxBirthYear ?? ""}
                  class={`w-24 ${INPUT_CLASS}`}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Source
                <input
                  type="text"
                  name="source"
                  value={filter.source ?? ""}
                  class={INPUT_CLASS}
                />
              </label>
              <label class="flex items-center gap-1.5 pb-1.5 text-sm text-gray-700">
                <input
                  type="checkbox"
                  name="recontact"
                  value="1"
                  checked={filter.requireRecontact}
                />
                consented to recontact
              </label>
              <button
                type="submit"
                class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Filter pool
              </button>
            </form>

            <form method="post" class="space-y-3">
              {data.matches.length === 0
                ? (
                  <p class="text-sm text-gray-500">
                    No pool members match (do-not-contact and already-enrolled
                    people are always excluded
                    {filter.requireRecontact &&
                      "; untick the recontact filter to include people who never signed a consent"}).
                  </p>
                )
                : (
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                        <th class="py-2 pr-3" />
                        <th class="py-2 pr-4">Code</th>
                        <th class="py-2 pr-4">Name</th>
                        <th class="py-2 pr-4">Born</th>
                        <th class="py-2 pr-4">Gender</th>
                        <th class="py-2 pr-4">Source</th>
                        <th class="py-2 pr-4">Channel</th>
                        <th class="py-2">Recontact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.matches.map((match) => (
                        <tr
                          key={match.participant.id}
                          class="border-b border-gray-100"
                        >
                          <td class="py-2 pr-3">
                            <input
                              type="checkbox"
                              name="ids"
                              value={match.participant.id}
                              disabled={!match.channel}
                            />
                          </td>
                          <td class="py-2 pr-4 font-medium">
                            {match.participant.code}
                          </td>
                          <td class="py-2 pr-4">{match.participant.name}</td>
                          <td class="py-2 pr-4">
                            {match.participant.yearOfBirth ?? "—"}
                          </td>
                          <td class="py-2 pr-4">
                            {match.participant.gender || "—"}
                          </td>
                          <td class="py-2 pr-4">
                            {match.participant.source || "—"}
                          </td>
                          <td class="py-2 pr-4">
                            {match.channel?.kind ?? "none"}
                          </td>
                          <td class="py-2">
                            {match.recontactOk
                              ? <StatusBadge status="consent_current" />
                              : <span class="text-gray-400">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              {data.matches.length > 0 && (
                <button
                  type="submit"
                  class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                  Invite selected to this study
                </button>
              )}
            </form>
          </div>
        )}
    </Layout>
  );
});
