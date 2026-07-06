// Export profiles (spec §3.6): what leaves StudyHub, at three privacy
// levels. Decisions (Decision Log candidates, documented here and in
// TODO.md):
//
//   full          PI-only. Stable participant codes, condition, session and
//                 provenance metadata, timestamps. Pilot rows only when
//                 explicitly requested (flagged). Codes are stable across
//                 the lab pool, so cross-study joins are possible — that is
//                 exactly why this profile is PI-gated.
//   de_identified Researcher+. Stable codes REPLACED by fresh per-export
//                 ids (P001…) assigned in shuffled order, rows shuffled,
//                 all metadata dropped (no timestamps, sessions, source
//                 keys). Condition kept. Pilot always excluded.
//   osf           Public/OSF-ready: de_identified, minus open-ended text
//                 columns (string columns with >20 distinct values) —
//                 free text is where self-identifying detail hides.
//                 Enumerable categorical strings survive.
//
// No profile ever touches PII: records never contain it (invariant since
// 4.1) and this module only sees record payloads + pseudonymous codes.
import type { LinkedRecord } from "../objects/datasets.ts";
import { buildCodebook } from "../objects/codebook.ts";

export type ExportProfile = "full" | "de_identified" | "osf";

export const EXPORT_PROFILES: ExportProfile[] = [
  "full",
  "de_identified",
  "osf",
];

export interface ProfileOutput {
  columns: string[];
  rows: Record<string, unknown>[];
}

const OSF_MAX_DISTINCT_TEXT = 20;

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function applyProfile(
  records: LinkedRecord[],
  profile: ExportProfile,
  opts: { includePilot?: boolean; rng?: () => number } = {},
): ProfileOutput {
  const rng = opts.rng ?? Math.random;
  const dataColumns: string[] = [];
  const seen = new Set<string>();
  for (const { record } of records) {
    for (const key of Object.keys(record.data)) {
      if (!seen.has(key)) {
        seen.add(key);
        dataColumns.push(key);
      }
    }
  }

  if (profile === "full") {
    // Pilot rows appear only on explicit request, and always flagged.
    const rows = (opts.includePilot
      ? records
      : records.filter(({ record }) =>
        !record.isPilot
      ))
      .map(({ record, participantCode, conditionName }) => ({
        participant_code: participantCode,
        condition: conditionName,
        session_id: record.sessionId,
        source_key: record.sourceKey,
        is_pilot: record.isPilot,
        recorded_at: record.createdAt.toISOString(),
        ...record.data,
      }));
    return {
      columns: [
        "participant_code",
        "condition",
        "session_id",
        "source_key",
        "is_pilot",
        "recorded_at",
        ...dataColumns,
      ],
      rows,
    };
  }

  // De-identified base: pilot is ALWAYS excluded; fresh ids in shuffled
  // order; rows shuffled so ordering leaks nothing.
  const visible = records.filter(({ record }) => !record.isPilot);
  const codes = [
    ...new Set(
      visible
        .map((r) => r.participantCode)
        .filter((c): c is string => c !== null),
    ),
  ];
  const width = Math.max(3, String(codes.length).length);
  const freshId = new Map<string, string>(
    shuffled(codes, rng).map((code, i) => [
      code,
      `P${String(i + 1).padStart(width, "0")}`,
    ]),
  );

  let columns = dataColumns;
  if (profile === "osf") {
    // Drop open-ended text columns: strings with many distinct values.
    const codebook = buildCodebook(visible.map(({ record }) => record.data));
    const openEnded = new Set(
      codebook
        .filter((e) =>
          (e.type === "string" || e.type === "mixed" || e.type === "array") &&
          e.distinct > OSF_MAX_DISTINCT_TEXT
        )
        .map((e) => e.key),
    );
    columns = dataColumns.filter((c) => !openEnded.has(c));
  }

  const rows = shuffled(visible, rng).map(
    ({ record, participantCode, conditionName }) => {
      const out: Record<string, unknown> = {
        participant: participantCode ? freshId.get(participantCode)! : null,
        condition: conditionName,
      };
      for (const column of columns) out[column] = record.data[column] ?? null;
      return out;
    },
  );
  return { columns: ["participant", "condition", ...columns], rows };
}
