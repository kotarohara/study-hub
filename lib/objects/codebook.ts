// Codebook generation (spec §3.6: analysis-ready bundles ship "data +
// codebook"). Pure: derives per-column documentation — inferred type,
// missingness, value inventory, numeric summaries — from record payloads.
// Shown on the dataset page and shipped with exports (4.5).

export type ColumnType = "number" | "string" | "array" | "mixed" | "empty";

export interface CodebookEntry {
  key: string;
  type: ColumnType;
  /** Rows where the column is present and non-empty. */
  nonMissing: number;
  missing: number;
  /** Distinct values, listed when there are at most `maxValues`. */
  values: string[] | null;
  distinct: number;
  /** Numeric summaries; null unless type is "number". */
  min: number | null;
  max: number | null;
  mean: number | null;
}

const MAX_LISTED_VALUES = 20;

function typeOf(value: unknown): ColumnType | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  return "string";
}

/** Builds a codebook over record payloads. Column order = first seen. */
export function buildCodebook(
  rows: Record<string, unknown>[],
): CodebookEntry[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }

  return keys.map((key) => {
    const present: unknown[] = [];
    for (const row of rows) {
      const t = typeOf(row[key]);
      if (t !== null) present.push(row[key]);
    }

    const types = new Set(present.map((v) => typeOf(v)));
    const type: ColumnType = present.length === 0
      ? "empty"
      : types.size > 1
      ? "mixed"
      : [...types][0]!;

    const asStrings = present.map((v) =>
      Array.isArray(v) ? v.join("; ") : String(v)
    );
    const distinctValues = [...new Set(asStrings)].sort();

    let min: number | null = null;
    let max: number | null = null;
    let mean: number | null = null;
    if (type === "number") {
      const nums = present as number[];
      min = Math.min(...nums);
      max = Math.max(...nums);
      mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    }

    return {
      key,
      type,
      nonMissing: present.length,
      missing: rows.length - present.length,
      values: distinctValues.length <= MAX_LISTED_VALUES
        ? distinctValues
        : null,
      distinct: distinctValues.length,
      min,
      max,
      mean,
    };
  });
}
