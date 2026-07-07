// Scale auto-scoring for EDA (spec §3.6: "scale auto-scoring from
// instrument rules"). The study's instruments (screener, diary) declare
// scoring rules; here their scores become derived `scale_<rule>` columns on
// each record so the EDA island and exports can treat them as ordinary
// numeric variables. Derivation is deterministic, so it runs server-side at
// load; per-variable statistics stay client-side in the island.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { diarySchedules, screeners } from "../db/schema.ts";
import type { Answers, FormItem, ScoringRule } from "../objects/forms.ts";
import { scoreResponse } from "../objects/forms.ts";
import { getVersion, versionForm } from "../objects/instruments.ts";

export interface ScoringForm {
  items: FormItem[];
  scoring: ScoringRule[];
}

/** Collects the scoring-rule-bearing form definitions attached to a study
 * (its screener and diary instruments, at their pinned versions). */
export async function studyScoringForms(
  db: Db,
  studyId: string,
): Promise<ScoringForm[]> {
  const forms: ScoringForm[] = [];
  const pinned: { instrumentId: string; version: number }[] = [];

  const screener = await db.query.screeners.findFirst({
    where: eq(screeners.studyId, studyId),
  });
  if (screener) {
    pinned.push({
      instrumentId: screener.instrumentId,
      version: screener.instrumentVersionNumber,
    });
  }
  const diary = await db.query.diarySchedules.findFirst({
    where: eq(diarySchedules.studyId, studyId),
  });
  if (diary) {
    pinned.push({
      instrumentId: diary.instrumentId,
      version: diary.instrumentVersionNumber,
    });
  }

  for (const pin of pinned) {
    const version = await getVersion(db, pin.instrumentId, pin.version);
    if (!version || !version.items) continue;
    const form = versionForm(version);
    if (form.scoring.length > 0) forms.push(form);
  }
  return forms;
}

/**
 * Appends `scale_<rule>` columns to each row for every rule that scores
 * (rules whose items are absent/incomplete on a row contribute nothing —
 * partial scales are misleading, so scoreResponse yields null). Pure.
 */
export function applyScaleScores(
  rows: Record<string, unknown>[],
  forms: ScoringForm[],
): Record<string, unknown>[] {
  if (forms.length === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const form of forms) {
      const scores = scoreResponse(form.items, form.scoring, row as Answers);
      for (const [key, score] of Object.entries(scores)) {
        if (score !== null) out[`scale_${key}`] = score;
      }
    }
    return out;
  });
}
