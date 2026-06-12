// Lab-side screener management: pick a simple-form instrument, define
// eligibility rules against its pinned version, share the public link,
// pause/resume, and triage responses (pseudonymous codes only).
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import type { Instrument, Screener, Study } from "../../../lib/db/schema.ts";
import { getStudyFor, isPilotStudy } from "../../../lib/objects/studies.ts";
import {
  getInstrument,
  getVersion,
  listInstruments,
} from "../../../lib/objects/instruments.ts";
import {
  configureScreener,
  getScreenerOfStudy,
  listScreenerResponses,
  type ResponseRow,
  type ScreenerDefinition,
  screenerDefinition,
  ScreenerError,
  screenerUrl,
  setScreenerStatus,
} from "../../../lib/objects/screeners.ts";
import {
  FormError,
  parseItems,
  parseScoring,
} from "../../../lib/objects/forms.ts";
import type { EligibilityRule } from "../../../lib/objects/eligibility.ts";
import { Layout } from "../../../components/Layout.tsx";
import { StatusBadge } from "../../../components/ooui/StatusBadge.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";

interface Data {
  study: Study;
  isPilot: boolean;
  screener: Screener | null;
  definition: ScreenerDefinition | null;
  publicUrl: string | null;
  instruments: Instrument[];
  responses: ResponseRow[];
  error?: string;
}

async function loadData(
  db: ReturnType<typeof getDb>,
  study: Study,
  error?: string,
): Promise<Data> {
  const screener = await getScreenerOfStudy(db, study.id);
  const definition = screener ? await screenerDefinition(db, screener) : null;
  return {
    study,
    isPilot: isPilotStudy(study),
    screener,
    definition,
    publicUrl: screener ? screenerUrl(screener) : null,
    instruments: (await listInstruments(db)).filter(
      (i) => i.kind === "simple_form",
    ),
    responses: screener ? await listScreenerResponses(db, screener.id) : [],
    error,
  };
}

/** rule_min_<key> / rule_max_<key> / rule_opt_<key> form fields → rules. */
function rulesFromForm(
  form: FormData,
  definition: ScreenerDefinition,
): EligibilityRule[] {
  const rules: EligibilityRule[] = [];
  for (const item of definition.items) {
    const min = String(form.get(`rule_min_${item.key}`) ?? "").trim();
    const max = String(form.get(`rule_max_${item.key}`) ?? "").trim();
    const anyOf = form.getAll(`rule_opt_${item.key}`).map(String);
    const rule: EligibilityRule = { item: item.key };
    if (min !== "") rule.min = Number(min);
    if (max !== "") rule.max = Number(max);
    if (anyOf.length > 0) rule.anyOf = anyOf;
    if (rule.min != null || rule.max != null || rule.anyOf) rules.push(rule);
  }
  return rules;
}

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getStudyFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);
    return page<Data>(await loadData(db, found.study));
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);
    const { study } = found;

    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const auditCtx = {
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    };

    try {
      if (action === "toggle") {
        if (!hasRole(me.role, "assistant")) throw new HttpError(403);
        const screener = await getScreenerOfStudy(db, study.id);
        if (!screener) throw new HttpError(404);
        await setScreenerStatus(db, {
          screener,
          status: screener.status === "open" ? "paused" : "open",
          actor: me,
          ...auditCtx,
        });
      } else {
        if (!hasRole(me.role, "researcher")) throw new HttpError(403);
        const instrument = await getInstrument(
          db,
          String(form.get("instrumentId") ?? ""),
        );
        if (!instrument) throw new HttpError(400);
        // Rules are parsed against the version being pinned right now.
        const pinned = await screenerDefinitionOf(db, instrument);
        await configureScreener(db, {
          study,
          instrument,
          eligibility: rulesFromForm(form, pinned),
          actor: me,
          ...auditCtx,
        });
      }
      return ctx.redirect(`/studies/${study.id}/screener`, 303);
    } catch (err) {
      if (err instanceof ScreenerError || err instanceof FormError) {
        return page<Data>(await loadData(db, study, err.message), {
          status: 400,
        });
      }
      throw err;
    }
  },
});

/** Definition of an instrument's CURRENT version (no screener yet). */
async function screenerDefinitionOf(
  db: ReturnType<typeof getDb>,
  instrument: Instrument,
): Promise<ScreenerDefinition> {
  const version = await getVersion(
    db,
    instrument.id,
    instrument.currentVersion,
  );
  if (!version) throw new ScreenerError("Instrument has no current version.");
  const items = parseItems(version.items);
  return { items, scoring: parseScoring(version.scoring, items), rules: [] };
}

const INPUT_CLASS = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { study, screener, definition } = data;
  const canConfigure = hasRole(me.role, "researcher");
  const canToggle = hasRole(me.role, "assistant");

  return (
    <Layout
      member={me}
      pathname={url.pathname}
      title={`Screener — ${study.name}`}
    >
      <div class="mb-4">
        <Chip
          href={`/studies/${study.id}`}
          icon="⚗"
          label={study.name}
          status={study.status}
        />
      </div>

      {data.error && (
        <p class="mb-4 max-w-2xl rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {data.error}
        </p>
      )}

      {data.isPilot
        ? (
          <p class="max-w-2xl rounded-card border border-purple-300 bg-purple-50 p-4 text-sm text-purple-900">
            Internal Pilot studies recruit manually-added participants only — no
            public screener pages (spec §3.3).
          </p>
        )
        : (
          <div class="space-y-8">
            {screener && data.publicUrl && (
              <section class="max-w-2xl space-y-2 rounded-card border border-gray-200 bg-white p-4">
                <div class="flex items-center gap-3">
                  <h2 class="text-sm font-semibold text-gray-900">
                    Public link
                  </h2>
                  <StatusBadge status={screener.status} />
                  <span class="text-xs text-gray-500">
                    {screener.views} views
                  </span>
                  <span class="flex-1" />
                  {canToggle && (
                    <form method="post">
                      <input type="hidden" name="action" value="toggle" />
                      <button
                        type="submit"
                        class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                      >
                        {screener.status === "open" ? "Pause" : "Resume"}
                      </button>
                    </form>
                  )}
                </div>
                <code class="block break-all rounded bg-gray-50 p-2 text-xs">
                  {data.publicUrl}
                </code>
                {study.status !== "recruiting" && (
                  <p class="text-xs text-amber-700">
                    The page only accepts submissions while the study status is
                    “recruiting” (currently “{study.status}”).
                  </p>
                )}
              </section>
            )}

            {canConfigure && (
              <form
                method="post"
                class="max-w-2xl space-y-4 rounded-card border border-gray-200 bg-white p-4"
              >
                <h2 class="text-sm font-semibold text-gray-900">
                  {screener ? "Reconfigure" : "Set up the screener"}
                </h2>
                <label class="flex flex-col gap-1 text-sm">
                  Simple-form instrument (pins its current version)
                  <select name="instrumentId" required class={INPUT_CLASS}>
                    {data.instruments.length === 0 && (
                      <option value="">
                        — create a simple-form instrument first —
                      </option>
                    )}
                    {data.instruments.map((instrument) => (
                      <option
                        key={instrument.id}
                        value={instrument.id}
                        selected={instrument.id === screener?.instrumentId}
                      >
                        {instrument.name} (v{instrument.currentVersion})
                      </option>
                    ))}
                  </select>
                </label>

                {definition && (
                  <fieldset class="space-y-3">
                    <legend class="text-sm font-medium text-gray-900">
                      Eligibility rules{" "}
                      <span class="font-normal text-gray-500">
                        (all must hold; empty = no constraint; applies when the
                        selected instrument is unchanged)
                      </span>
                    </legend>
                    {definition.items.map((item) => {
                      const rule = definition.rules.find(
                        (r) => r.item === item.key,
                      );
                      if (item.type === "number" || item.type === "likert") {
                        return (
                          <div
                            key={item.key}
                            class="flex items-center gap-2 text-sm"
                          >
                            <span class="w-56 truncate" title={item.prompt}>
                              {item.prompt}
                            </span>
                            <input
                              type="number"
                              name={`rule_min_${item.key}`}
                              placeholder="min"
                              value={rule?.min ?? ""}
                              class={`w-24 ${INPUT_CLASS}`}
                            />
                            <input
                              type="number"
                              name={`rule_max_${item.key}`}
                              placeholder="max"
                              value={rule?.max ?? ""}
                              class={`w-24 ${INPUT_CLASS}`}
                            />
                          </div>
                        );
                      }
                      if (
                        item.type === "single_choice" ||
                        item.type === "multi_choice"
                      ) {
                        return (
                          <div key={item.key} class="text-sm">
                            <p class="mb-1">{item.prompt} — accept:</p>
                            <div class="flex flex-wrap gap-3 pl-2">
                              {item.options.map((option) => (
                                <label
                                  key={option}
                                  class="flex items-center gap-1.5"
                                >
                                  <input
                                    type="checkbox"
                                    name={`rule_opt_${item.key}`}
                                    value={option}
                                    checked={rule?.anyOf?.includes(option) ??
                                      false}
                                  />
                                  {option}
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </fieldset>
                )}

                <button
                  type="submit"
                  class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                  Save screener
                </button>
              </form>
            )}

            {screener && (
              <section class="space-y-2">
                <h2 class="text-sm font-semibold text-gray-900">
                  Responses ({data.responses.length})
                </h2>
                {data.responses.length === 0
                  ? (
                    <p class="text-sm text-gray-500">
                      No submissions yet — share the public link.
                    </p>
                  )
                  : (
                    <table class="w-full max-w-3xl text-sm">
                      <thead>
                        <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                          <th class="py-2 pr-4">Participant</th>
                          <th class="py-2 pr-4">Submitted</th>
                          <th class="py-2 pr-4">Eligibility</th>
                          <th class="py-2 pr-4">Enrollment</th>
                          <th class="py-2">Form</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.responses.map((row) => (
                          <tr key={row.id} class="border-b border-gray-100">
                            <td class="py-2 pr-4">
                              <a
                                href={`/participants/${row.participantId}`}
                                class="font-medium text-brand-700 hover:underline"
                              >
                                {row.participantCode}
                              </a>
                            </td>
                            <td class="py-2 pr-4">
                              {row.createdAt.toISOString().slice(0, 16)
                                .replace("T", " ")}
                            </td>
                            <td class="py-2 pr-4">
                              <StatusBadge
                                status={row.eligible ? "eligible" : "screened"}
                              />
                            </td>
                            <td class="py-2 pr-4">
                              <StatusBadge status={row.enrollmentStatus} />
                            </td>
                            <td class="py-2 text-xs text-gray-500">
                              v{row.instrumentVersionNumber}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </section>
            )}
          </div>
        )}
    </Layout>
  );
});
