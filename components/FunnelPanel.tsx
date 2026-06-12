// "Recruitment" tab of the study detail view (spec §3.4): funnel stages,
// per-channel breakdown, per-condition quotas vs targets, and the manual
// screener pause (auto-pause was cut from scope). Pseudonymous counts
// only — no PII anywhere on this tab.
import type { Study } from "../lib/db/schema.ts";
import type { StudyFunnel } from "../lib/objects/funnel.ts";
import { StatusBadge } from "./ooui/StatusBadge.tsx";

function QuotaBar(props: { count: number; target: number | null }) {
  if (props.target == null) {
    return <span class="text-sm text-gray-700">{props.count}</span>;
  }
  const pct = Math.min(100, Math.round((props.count / props.target) * 100));
  const full = props.count >= props.target;
  return (
    <span class="flex items-center gap-2">
      <span class="h-2 w-32 overflow-hidden rounded bg-gray-100">
        <span
          class={`block h-full ${full ? "bg-amber-500" : "bg-brand-600"}`}
          style={`width: ${pct}%`}
        />
      </span>
      <span
        class={`text-sm ${
          full ? "font-medium text-amber-700" : "text-gray-700"
        }`}
      >
        {props.count} / {props.target}
        {full && " — full"}
      </span>
    </span>
  );
}

export function FunnelPanel(props: {
  study: Study;
  funnel: StudyFunnel;
  canOperate: boolean;
}) {
  const { study, funnel } = props;

  return (
    <div class="space-y-8">
      <section>
        <div class="flex flex-wrap gap-3">
          {funnel.stages.map((stage) => (
            <div
              key={stage.id}
              class="min-w-28 rounded-card border border-gray-200 bg-white p-3 text-center"
            >
              <p class="text-2xl font-bold text-gray-900">{stage.count}</p>
              <p class="text-xs uppercase tracking-wide text-gray-500">
                {stage.label}
              </p>
            </div>
          ))}
        </div>
        {funnel.pilotCount > 0 && (
          <p class="mt-2 text-xs text-purple-700">
            + {funnel.pilotCount} pilot enrollment
            {funnel.pilotCount > 1 ? "s" : ""}{" "}
            (quarantined — excluded from all funnel and quota numbers).
          </p>
        )}
      </section>

      <section class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-900">Quotas</h2>
        <table class="w-full max-w-xl text-sm">
          <tbody>
            <tr class="border-b border-gray-200">
              <td class="py-2 pr-4 font-medium">Overall (consented+)</td>
              <td class="py-2">
                <QuotaBar
                  count={funnel.overall.count}
                  target={funnel.overall.target}
                />
              </td>
            </tr>
            {funnel.quotas.map((quota) => (
              <tr key={quota.name} class="border-b border-gray-100">
                <td class="py-2 pr-4">{quota.name}</td>
                <td class="py-2">
                  <QuotaBar count={quota.count} target={quota.target} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {funnel.overall.target == null && (
          <p class="text-xs text-gray-500">
            Set a target N in the design editor to get quota targets.
          </p>
        )}
      </section>

      <section class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-900">
          Funnel by recruitment channel
        </h2>
        {funnel.bySource.length === 0
          ? <p class="text-sm text-gray-500">No enrollments yet.</p>
          : (
            <table class="w-full max-w-2xl text-sm">
              <thead>
                <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th class="py-2 pr-4">Channel</th>
                  <th class="py-2 pr-4">Screened</th>
                  <th class="py-2 pr-4">Eligible</th>
                  <th class="py-2 pr-4">Consented</th>
                  <th class="py-2">Completed</th>
                </tr>
              </thead>
              <tbody>
                {funnel.bySource.map((row) => (
                  <tr key={row.source} class="border-b border-gray-100">
                    <td class="py-2 pr-4 font-medium">{row.source}</td>
                    {row.stages.map((stage) => (
                      <td key={stage.id} class="py-2 pr-4">{stage.count}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      <section class="flex flex-wrap items-center gap-3">
        {funnel.screenerStatus
          ? (
            <>
              <span class="text-sm text-gray-700">Public screener:</span>
              <StatusBadge status={funnel.screenerStatus} />
              {props.canOperate && (
                <form method="post" action={`/studies/${study.id}/screener`}>
                  <input type="hidden" name="action" value="toggle" />
                  <input
                    type="hidden"
                    name="back"
                    value={`/studies/${study.id}?tab=recruitment`}
                  />
                  <button
                    type="submit"
                    class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    {funnel.screenerStatus === "open"
                      ? "Pause screener"
                      : "Resume screener"}
                  </button>
                </form>
              )}
            </>
          )
          : (
            <span class="text-sm text-gray-500">
              No public screener configured.
            </span>
          )}
        <a
          href={`/studies/${study.id}/screener`}
          class="text-sm text-brand-700 hover:underline"
        >
          Screener settings →
        </a>
      </section>
    </div>
  );
}
