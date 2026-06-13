import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Instrument, InstrumentVersion } from "../../../lib/db/schema.ts";
import {
  getInstrument,
  getVersion,
  listVersions,
  versionForm,
} from "../../../lib/objects/instruments.ts";
import type { FormItem, ScoringRule } from "../../../lib/objects/forms.ts";
import { listScreenersOfInstrument } from "../../../lib/objects/screeners.ts";
import { Chip } from "../../../components/ooui/Chip.tsx";
import { Layout } from "../../../components/Layout.tsx";
import { DetailView } from "../../../components/ooui/DetailView.tsx";
import { FormRender } from "../../../components/FormRender.tsx";
import { resolveActions } from "../../../lib/ooui/actions.ts";

interface Data {
  instrument: Instrument;
  /** Version on display: current on overview, selectable on versions tab. */
  shown: InstrumentVersion;
  form: { items: FormItem[]; scoring: ScoringRule[] } | null;
  versions: InstrumentVersion[];
  usage: { studyId: string; studyName: string; pinned: number }[];
  activeTab: string;
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "versions", label: "Versions" },
  { id: "usage", label: "Usage" },
];

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const instrument = await getInstrument(db, ctx.params.id);
    if (!instrument) throw new HttpError(404);

    const activeTab = TABS.some((t) => t.id === ctx.url.searchParams.get("tab"))
      ? ctx.url.searchParams.get("tab")!
      : "overview";

    const requested = Number(ctx.url.searchParams.get("v"));
    const versionNumber =
      activeTab === "versions" && Number.isInteger(requested) && requested >= 1
        ? requested
        : instrument.currentVersion;
    const shown = await getVersion(db, instrument.id, versionNumber);
    if (!shown) throw new HttpError(404);

    return page<Data>({
      instrument,
      shown,
      form: instrument.kind === "simple_form" ? versionForm(shown) : null,
      versions: await listVersions(db, instrument.id),
      usage: activeTab === "usage"
        ? (await listScreenersOfInstrument(db, instrument.id)).map((u) => ({
          studyId: u.studyId,
          studyName: u.studyName,
          pinned: u.screener.instrumentVersionNumber,
        }))
        : [],
      activeTab,
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { instrument, shown, form } = data;

  const actions = resolveActions(
    [
      {
        id: "revise",
        label: "New version",
        href: `/instruments/${instrument.id}/versions/new`,
        method: "get",
        tone: "primary",
        minRole: "researcher",
      },
    ],
    { role: me.role },
  );

  const preview = (
    <div class="max-w-2xl space-y-6">
      {shown.versionNumber !== instrument.currentVersion && (
        <p class="rounded-card border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Viewing v{shown.versionNumber} — the current version is v
          {instrument.currentVersion}.
        </p>
      )}
      {instrument.kind === "external"
        ? (
          <p class="text-sm">
            External instrument:{" "}
            <a
              href={shown.externalUrl ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              class="text-brand-700 underline"
            >
              {shown.externalUrl}
            </a>
          </p>
        )
        : form && (
          <>
            <FormRender items={form.items} disabled />
            {form.scoring.length > 0 && (
              <section>
                <h2 class="mb-2 text-sm font-semibold text-gray-900">
                  Scoring rules
                </h2>
                <ul class="space-y-1 text-sm text-gray-700">
                  {form.scoring.map((rule) => (
                    <li key={rule.key}>
                      <span class="font-medium">{rule.name}</span>:{" "}
                      {rule.aggregate} of{" "}
                      {rule.items.map((key) =>
                        rule.reverse.includes(key) ? `${key} (reversed)` : key
                      ).join(", ")}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
    </div>
  );

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="☰"
        typeLabel="Instrument"
        title={instrument.name}
        status={instrument.kind}
        properties={[
          { label: "Purpose", value: instrument.purpose.replaceAll("_", " ") },
          { label: "Version", value: `v${instrument.currentVersion}` },
          {
            label: "Created",
            value: instrument.createdAt.toISOString().slice(0, 10),
          },
          {
            label: "Updated",
            value: instrument.updatedAt.toISOString().slice(0, 10),
          },
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={`/instruments/${instrument.id}`}
        actions={actions}
      >
        {data.activeTab === "overview" && preview}

        {data.activeTab === "versions" && (
          <div class="space-y-4">
            <table class="w-full max-w-2xl text-sm">
              <thead>
                <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th class="py-2 pr-4">Version</th>
                  <th class="py-2 pr-4">Created</th>
                  <th class="py-2">Change note</th>
                </tr>
              </thead>
              <tbody>
                {data.versions.map((version) => (
                  <tr
                    key={version.id}
                    class={`border-b border-gray-100 ${
                      version.versionNumber === shown.versionNumber
                        ? "bg-brand-50"
                        : ""
                    }`}
                  >
                    <td class="py-2 pr-4">
                      <a
                        href={`/instruments/${instrument.id}?tab=versions&v=${version.versionNumber}`}
                        class="font-medium text-brand-700 hover:underline"
                      >
                        v{version.versionNumber}
                        {version.versionNumber === instrument.currentVersion &&
                          " (current)"}
                      </a>
                    </td>
                    <td class="py-2 pr-4">
                      {version.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td class="py-2 text-gray-700">
                      {version.changeNote || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview}
          </div>
        )}

        {data.activeTab === "usage" && (
          data.usage.length === 0
            ? (
              <p class="text-sm text-gray-500">
                Not used by any study screener yet.
              </p>
            )
            : (
              <div class="flex flex-wrap gap-2">
                {data.usage.map((u) => (
                  <Chip
                    key={u.studyId}
                    href={`/studies/${u.studyId}/screener`}
                    icon="⚗"
                    label={u.studyName}
                    sublabel={`screener · pinned v${u.pinned}`}
                  />
                ))}
              </div>
            )
        )}
      </DetailView>
    </Layout>
  );
});
