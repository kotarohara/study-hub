// EDA statistics (spec §3.6): pure, dependency-free, shared by the
// EdaCharts island (client-side computation) and its tests. Quartiles use
// linear interpolation (R type 7), matching what researchers will see when
// they re-run the numbers locally.

export interface NumericSummary {
  n: number;
  mean: number;
  sd: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

/** Interpolated quantile over a SORTED array (R type 7). */
export function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function numericSummary(values: number[]): NumericSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = n < 2
    ? 0
    : sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return {
    n,
    mean,
    sd: Math.sqrt(variance),
    min: sorted[0],
    q1: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
    max: sorted[n - 1],
  };
}

export interface HistogramBin {
  start: number;
  end: number;
  count: number;
}

/**
 * Fixed-width bins across [min, max]; the last bin is closed on both ends
 * so the maximum lands in it. A constant column yields one full bin.
 */
export function histogram(values: number[], binCount = 10): HistogramBin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ start: min, end: max, count: values.length }];
  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    start: min + i * width,
    end: min + (i + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(Math.floor((value - min) / width), binCount - 1);
    bins[index].count++;
  }
  return bins;
}

/** Rows a chart works over: a group label (condition) + a value. */
export interface GroupSummary {
  group: string;
  summary: NumericSummary;
}

/** Per-group numeric summaries, groups sorted by name; null/absent groups
 * pool under "(none)". */
export function summarizeByGroup(
  rows: { group: string | null; value: number }[],
): GroupSummary[] {
  const byGroup = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.group ?? "(none)";
    const list = byGroup.get(key) ?? [];
    list.push(row.value);
    byGroup.set(key, list);
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, values]) => ({ group, summary: numericSummary(values)! }));
}

/** Extracts the numeric values of one column from record payloads. */
export function numericColumn(
  rows: Record<string, unknown>[],
  key: string,
): number[] {
  return rows
    .map((row) => row[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** Columns where every non-missing value is numeric (and at least one is). */
export function numericColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
  return [...keys].filter((key) => {
    let seen = 0;
    for (const row of rows) {
      const value = row[key];
      if (value === null || value === undefined || value === "") continue;
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      seen++;
    }
    return seen > 0;
  });
}
