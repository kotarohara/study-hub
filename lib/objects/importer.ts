// Generic CSV/JSON importer (spec §3.5 "generic CSV mapper", §4: no
// Qualtrics/Prolific-specific importers). Pure parsing + mapping here; the
// database half (code → enrollment resolution, record insertion) lives in
// importIntoDataset below. CSV parsing is hand-rolled RFC-4180-style
// (quoted fields, escaped quotes, CR/LF) — main surveys stay in
// Qualtrics/Google Forms and arrive here as their CSV exports.
import { inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Dataset,
  enrollments,
  participants,
  type Study,
} from "../db/schema.ts";
import { addRecords } from "./datasets.ts";

export class ImportError extends Error {}

// --- parsing ---------------------------------------------------------------

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/** Parses RFC-4180-style CSV: quoted fields, "" escapes, CRLF/LF endings.
 * The first row is the header. Ragged rows are padded/truncated to it. */
export function parseCsv(text: string): ParsedTable {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  if (inQuotes) throw new ImportError("Unterminated quoted field in CSV.");

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2) {
    throw new ImportError("The CSV needs a header row and at least one row.");
  }
  const headers = nonEmpty[0].map((h) => h.trim());
  if (headers.some((h) => !h)) {
    throw new ImportError("Every CSV column needs a header.");
  }
  const body = nonEmpty.slice(1).map((r) => {
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push("");
    return padded;
  });
  return { headers, rows: body };
}

/** Parses a JSON array of flat objects into the same tabular shape. */
export function parseJsonRows(text: string): ParsedTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError("Not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ImportError("Expected a non-empty JSON array of objects.");
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ImportError("Every JSON row must be a flat object.");
    }
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const rows = (parsed as Record<string, unknown>[]).map((item) =>
    headers.map((h) => {
      const value = item[h];
      if (value === null || value === undefined) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    })
  );
  return { headers, rows };
}

/** Picks a parser by filename/content type. */
export function parseTable(
  fileName: string,
  text: string,
): ParsedTable {
  return fileName.toLowerCase().endsWith(".json")
    ? parseJsonRows(text)
    : parseCsv(text);
}

// --- mapping ----------------------------------------------------------------

export interface ImportMapping {
  /** Column holding the pseudonymous participant code (linkage), or null
   * for an unlinked import. */
  codeColumn: string | null;
  /** Columns to keep as record data (the mapping UI's selection). */
  keepColumns: string[];
}

export interface MappedRow {
  code: string | null;
  data: Record<string, string | number>;
}

/** Numbers import as numbers so EDA/codebook see numeric columns. */
function coerce(value: string): string | number {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const n = Number(trimmed);
  return Number.isFinite(n) && /^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)
    ? n
    : value;
}

/** Applies the column mapping: extracts the linkage code, keeps selected
 * columns (never the code column itself — linkage is not row data). */
export function applyMapping(
  table: ParsedTable,
  mapping: ImportMapping,
): MappedRow[] {
  const index = new Map(table.headers.map((h, i) => [h, i]));
  if (mapping.codeColumn !== null && !index.has(mapping.codeColumn)) {
    throw new ImportError(`Unknown code column "${mapping.codeColumn}".`);
  }
  const keep = mapping.keepColumns.filter(
    (c) => index.has(c) && c !== mapping.codeColumn,
  );
  if (keep.length === 0) {
    throw new ImportError("Select at least one data column to import.");
  }
  return table.rows.map((row) => {
    const data: Record<string, string | number> = {};
    for (const column of keep) data[column] = coerce(row[index.get(column)!]);
    const code = mapping.codeColumn === null
      ? null
      : row[index.get(mapping.codeColumn)!].trim() || null;
    return { code, data };
  });
}

// --- database half -----------------------------------------------------------

export interface ImportResult {
  inserted: number;
  deduped: number;
  /** Rows whose code matched an enrollment of this study. */
  linked: number;
  /** Distinct codes that matched nothing (rows kept, unlinked). */
  unmatchedCodes: string[];
}

/**
 * Imports mapped rows into a dataset. Codes resolve to enrollments of the
 * dataset's study; unmatched rows are kept but stay unlinked (and are
 * reported so the researcher can fix the source). Idempotent per
 * `<sourceKeyPrefix>:<rowIndex>` — re-importing the same file is a no-op.
 */
export async function importIntoDataset(
  db: Db,
  opts: {
    dataset: Dataset;
    study: Study;
    rows: MappedRow[];
    sourceKeyPrefix: string;
  },
): Promise<ImportResult> {
  const codes = [
    ...new Set(
      opts.rows.map((r) => r.code).filter((c): c is string => c !== null),
    ),
  ];
  const byCode = new Map<string, string>();
  if (codes.length > 0) {
    const found = await db
      .select({ code: participants.code, enrollmentId: enrollments.id })
      .from(enrollments)
      .innerJoin(participants, eq(enrollments.participantId, participants.id))
      .where(
        and(
          eq(enrollments.studyId, opts.study.id),
          inArray(participants.code, codes),
        ),
      );
    for (const row of found) byCode.set(row.code, row.enrollmentId);
  }

  const result = await addRecords(db, {
    dataset: opts.dataset,
    rows: opts.rows.map((row, i) => ({
      enrollmentId: row.code ? byCode.get(row.code) ?? null : null,
      data: row.data,
      sourceKey: `${opts.sourceKeyPrefix}:${i}`,
    })),
  });
  const linked = opts.rows.filter((r) => r.code && byCode.has(r.code)).length;
  return {
    inserted: result.inserted,
    deduped: result.deduped,
    linked,
    unmatchedCodes: codes.filter((c) => !byCode.has(c)),
  };
}
