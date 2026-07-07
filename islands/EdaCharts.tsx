// EDA island (spec §3.6, §6 layout): summary statistics, a histogram, and
// group-by-condition box plots for one numeric variable at a time. All
// computation runs client-side over the serialized (pilot-quarantined)
// records — inferential work stays in R/Python by design. Colors follow
// the app's brand palette.
import { useMemo, useState } from "preact/hooks";
import {
  type GroupSummary,
  histogram,
  numericColumn,
  numericSummary,
  summarizeByGroup,
} from "../lib/eda/stats.ts";

export interface EdaRow {
  condition: string | null;
  data: Record<string, unknown>;
}

export interface EdaChartsProps {
  rows: EdaRow[];
  /** Columns where every non-missing value is numeric. */
  numericKeys: string[];
}

const CHART_W = 560;
const CHART_H = 180;
const PAD = 28;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function Histogram({ values }: { values: number[] }) {
  const bins = histogram(values);
  if (bins.length === 0) return null;
  const maxCount = Math.max(...bins.map((b) => b.count));
  const innerW = CHART_W - PAD * 2;
  const innerH = CHART_H - PAD * 2;
  const barW = innerW / bins.length;
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      class="max-w-full"
      role="img"
      aria-label="Histogram"
    >
      {bins.map((bin, i) => {
        const h = maxCount === 0 ? 0 : (bin.count / maxCount) * innerH;
        return (
          <g key={i}>
            <rect
              x={PAD + i * barW + 1}
              y={PAD + innerH - h}
              width={Math.max(barW - 2, 1)}
              height={h}
              class="fill-brand-600"
            >
              <title>
                {`${fmt(bin.start)}–${fmt(bin.end)}: ${bin.count}`}
              </title>
            </rect>
          </g>
        );
      })}
      <line
        x1={PAD}
        y1={PAD + innerH}
        x2={PAD + innerW}
        y2={PAD + innerH}
        class="stroke-gray-300"
      />
      <text x={PAD} y={CHART_H - 6} class="fill-gray-500 text-[10px]">
        {fmt(bins[0].start)}
      </text>
      <text
        x={PAD + innerW}
        y={CHART_H - 6}
        text-anchor="end"
        class="fill-gray-500 text-[10px]"
      >
        {fmt(bins[bins.length - 1].end)}
      </text>
      <text x={4} y={PAD + 4} class="fill-gray-500 text-[10px]">
        max {maxCount}
      </text>
    </svg>
  );
}

function BoxPlots({ groups }: { groups: GroupSummary[] }) {
  if (groups.length === 0) return null;
  const min = Math.min(...groups.map((g) => g.summary.min));
  const max = Math.max(...groups.map((g) => g.summary.max));
  const span = max - min || 1;
  const innerW = CHART_W - PAD * 2;
  const rowH = 44;
  const height = PAD + groups.length * rowH + PAD / 2;
  const x = (v: number) => PAD + ((v - min) / span) * innerW;
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${height}`}
      class="max-w-full"
      role="img"
      aria-label="Box plots by condition"
    >
      {groups.map((g, i) => {
        const cy = PAD + i * rowH + rowH / 2;
        const s = g.summary;
        return (
          <g key={g.group}>
            <text x={PAD} y={cy - 14} class="fill-gray-700 text-[11px]">
              {g.group} (n={s.n})
            </text>
            <line
              x1={x(s.min)}
              y1={cy}
              x2={x(s.max)}
              y2={cy}
              class="stroke-gray-400"
            />
            <rect
              x={x(s.q1)}
              y={cy - 8}
              width={Math.max(x(s.q3) - x(s.q1), 1)}
              height={16}
              class="fill-brand-100 stroke-brand-600"
            >
              <title>
                {`${g.group}: min ${fmt(s.min)}, Q1 ${fmt(s.q1)}, median ${
                  fmt(s.median)
                }, Q3 ${fmt(s.q3)}, max ${fmt(s.max)}`}
              </title>
            </rect>
            <line
              x1={x(s.median)}
              y1={cy - 8}
              x2={x(s.median)}
              y2={cy + 8}
              class="stroke-brand-700"
              stroke-width={2}
            />
          </g>
        );
      })}
      <text x={PAD} y={height - 4} class="fill-gray-500 text-[10px]">
        {fmt(min)}
      </text>
      <text
        x={PAD + innerW}
        y={height - 4}
        text-anchor="end"
        class="fill-gray-500 text-[10px]"
      >
        {fmt(max)}
      </text>
    </svg>
  );
}

export default function EdaCharts(props: EdaChartsProps) {
  const [variable, setVariable] = useState(props.numericKeys[0] ?? "");
  const payloads = useMemo(
    () => props.rows.map((r) => r.data),
    [props.rows],
  );
  const values = useMemo(
    () => (variable ? numericColumn(payloads, variable) : []),
    [payloads, variable],
  );
  const summary = numericSummary(values);
  const groups = useMemo(
    () =>
      variable
        ? summarizeByGroup(
          props.rows
            .filter((r) => typeof r.data[variable] === "number")
            .map((r) => ({
              group: r.condition,
              value: r.data[variable] as number,
            })),
        )
        : [],
    [props.rows, variable],
  );

  if (props.numericKeys.length === 0) {
    return (
      <p class="text-sm text-gray-500">
        No numeric variables to explore yet.
      </p>
    );
  }

  return (
    <div class="space-y-6">
      <label class="flex items-center gap-2 text-sm">
        Variable
        <select
          value={variable}
          onChange={(e) => setVariable((e.target as HTMLSelectElement).value)}
          class="rounded-card border border-gray-300 px-2 py-1.5 text-sm"
        >
          {props.numericKeys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <span class="text-xs text-gray-500">
          computed in your browser over {props.rows.length} records
        </span>
      </label>

      {summary && (
        <table class="text-sm">
          <thead>
            <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              {["n", "mean", "sd", "min", "q1", "median", "q3", "max"].map(
                (h) => <th key={h} class="py-1.5 pr-5">{h}</th>,
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="py-1.5 pr-5">{summary.n}</td>
              <td class="py-1.5 pr-5">{fmt(summary.mean)}</td>
              <td class="py-1.5 pr-5">{fmt(summary.sd)}</td>
              <td class="py-1.5 pr-5">{fmt(summary.min)}</td>
              <td class="py-1.5 pr-5">{fmt(summary.q1)}</td>
              <td class="py-1.5 pr-5">{fmt(summary.median)}</td>
              <td class="py-1.5 pr-5">{fmt(summary.q3)}</td>
              <td class="py-1.5 pr-5">{fmt(summary.max)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <section class="space-y-1">
        <h3 class="text-sm font-semibold text-gray-900">Distribution</h3>
        <Histogram values={values} />
      </section>

      {groups.length > 1 && (
        <section class="space-y-1">
          <h3 class="text-sm font-semibold text-gray-900">By condition</h3>
          <BoxPlots groups={groups} />
        </section>
      )}
    </div>
  );
}
