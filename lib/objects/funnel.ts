// Recruitment funnel + quota dashboard (spec §3.4): viewed → screened →
// eligible → consented → completed, per recruitment channel (participant
// `source`), and per-condition counts vs targets. Pilot enrollments are
// quarantined data and excluded from every funnel/quota number (spec §4
// kept-feature 5); their count is reported separately. Auto-pause was cut
// from scope — the dashboard surfaces the numbers and researchers pause
// the screener manually.
import { count, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { enrollments, participants, type Study } from "../db/schema.ts";
import { listConditions } from "./design.ts";
import type { EnrollmentStatus } from "./enrollments.ts";
import { getScreenerOfStudy } from "./screeners.ts";

export type StatusCounts = Partial<Record<EnrollmentStatus, number>>;

/** Statuses at-or-past each funnel stage (approximated by CURRENT status —
 * we don't replay history, so e.g. a withdrawn participant counts as
 * screened but not as eligible even if they once were). */
const STAGE_STATUSES: Record<string, EnrollmentStatus[]> = {
  screened: [
    "screened",
    "eligible",
    "consented",
    "active",
    "completed",
    "withdrawn",
    "excluded",
  ],
  eligible: ["eligible", "consented", "active", "completed"],
  consented: ["consented", "active", "completed"],
  completed: ["completed"],
};

export interface FunnelStage {
  id: string;
  label: string;
  count: number;
}

/** Pure: status counts (+ optional screener views) → cumulative stages. */
export function funnelStages(
  byStatus: StatusCounts,
  views?: number | null,
): FunnelStage[] {
  const sum = (statuses: EnrollmentStatus[]) =>
    statuses.reduce((total, status) => total + (byStatus[status] ?? 0), 0);
  const stages: FunnelStage[] = [];
  if (views != null) {
    stages.push({ id: "viewed", label: "Viewed", count: views });
  }
  stages.push(
    { id: "screened", label: "Screened", count: sum(STAGE_STATUSES.screened) },
    { id: "eligible", label: "Eligible", count: sum(STAGE_STATUSES.eligible) },
    {
      id: "consented",
      label: "Consented",
      count: sum(STAGE_STATUSES.consented),
    },
    {
      id: "completed",
      label: "Completed",
      count: sum(STAGE_STATUSES.completed),
    },
  );
  return stages;
}

/** Pure: even split of the study's target N across conditions. */
export function perConditionTarget(
  targetN: number | null,
  conditionCount: number,
): number | null {
  if (targetN == null || conditionCount === 0) return null;
  return Math.ceil(targetN / conditionCount);
}

export interface SourceFunnelRow {
  source: string;
  stages: FunnelStage[];
}

export interface ConditionQuota {
  conditionId: string | null;
  name: string;
  /** Non-pilot enrollments holding a spot (consented/active/completed). */
  count: number;
  target: number | null;
}

export interface StudyFunnel {
  stages: FunnelStage[];
  bySource: SourceFunnelRow[];
  quotas: ConditionQuota[];
  /** Overall consented+ count vs the study's target N. */
  overall: { count: number; target: number | null };
  pilotCount: number;
  screenerStatus: "open" | "paused" | null;
}

/** Statuses that hold a spot against quota. */
const QUOTA_STATUSES: EnrollmentStatus[] = ["consented", "active", "completed"];

export async function studyFunnel(db: Db, study: Study): Promise<StudyFunnel> {
  const screener = await getScreenerOfStudy(db, study.id);

  const rows = await db
    .select({
      status: enrollments.status,
      isPilot: enrollments.isPilot,
      conditionId: enrollments.conditionId,
      source: participants.source,
      n: count(),
    })
    .from(enrollments)
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(enrollments.studyId, study.id))
    .groupBy(
      enrollments.status,
      enrollments.isPilot,
      enrollments.conditionId,
      participants.source,
    );

  const byStatus: StatusCounts = {};
  const bySourceCounts = new Map<string, StatusCounts>();
  const byCondition = new Map<string, number>();
  let pilotCount = 0;
  let overallCount = 0;

  for (const row of rows) {
    const n = Number(row.n);
    if (row.isPilot) {
      pilotCount += n;
      continue; // quarantined: never in funnel or quota numbers
    }
    byStatus[row.status] = (byStatus[row.status] ?? 0) + n;
    const source = row.source || "(unknown)";
    const sourceCounts = bySourceCounts.get(source) ?? {};
    sourceCounts[row.status] = (sourceCounts[row.status] ?? 0) + n;
    bySourceCounts.set(source, sourceCounts);
    if (QUOTA_STATUSES.includes(row.status)) {
      overallCount += n;
      if (row.conditionId) {
        byCondition.set(
          row.conditionId,
          (byCondition.get(row.conditionId) ?? 0) + n,
        );
      }
    }
  }

  const conditions = await listConditions(db, study.id);
  const target = perConditionTarget(study.targetN, conditions.length);
  const quotas: ConditionQuota[] = conditions.map((condition) => ({
    conditionId: condition.id,
    name: condition.name,
    count: byCondition.get(condition.id) ?? 0,
    target,
  }));
  const unassigned = overallCount -
    quotas.reduce((total, quota) => total + quota.count, 0);
  if (conditions.length > 0 && unassigned > 0) {
    quotas.push({
      conditionId: null,
      name: "(no condition yet)",
      count: unassigned,
      target: null,
    });
  }

  return {
    stages: funnelStages(byStatus, screener ? screener.views : null),
    bySource: [...bySourceCounts.entries()]
      .map(([source, counts]) => ({
        source,
        stages: funnelStages(counts),
      }))
      .sort((a, b) => b.stages[0].count - a.stages[0].count),
    quotas,
    overall: { count: overallCount, target: study.targetN },
    pilotCount,
    screenerStatus: screener?.status ?? null,
  };
}
