// Health dashboard data (spec §5.2 / phase item 5.2): recruiting progress
// vs target N for live studies, the coming week's sessions, and overdue
// milestones — the "is anything rotting?" view. Pseudonymous codes only.
import { and, asc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  enrollments,
  type Member,
  milestones,
  participants,
  type Study,
  studySessions,
} from "../db/schema.ts";
import { listStudiesFor } from "./studies.ts";
import { studyFunnel } from "./funnel.ts";

export interface StudyProgress {
  studyId: string;
  studyName: string;
  status: Study["status"];
  /** Consented+ enrollments vs the target (null target = untracked). */
  enrolled: number;
  target: number | null;
}

export interface UpcomingSession {
  sessionId: string;
  studyId: string;
  studyName: string;
  participantCode: string | null;
  startsAt: Date;
  location: string;
}

export interface OverdueMilestone {
  milestoneId: string;
  studyId: string | null;
  studyName: string | null;
  title: string;
  dueOn: Date;
  status: string;
}

export interface HealthSnapshot {
  progress: StudyProgress[];
  upcoming: UpcomingSession[];
  overdue: OverdueMilestone[];
}

const LIVE_STATES: Study["status"][] = ["recruiting", "running", "analysis"];

/** Booked sessions in the next `days` for the given studies. */
async function upcomingSessions(
  db: Db,
  studyIds: string[],
  studyNames: Map<string, string>,
  days: number,
  now: Date,
): Promise<UpcomingSession[]> {
  if (studyIds.length === 0) return [];
  const horizon = new Date(now.getTime() + days * 86_400_000);
  const rows = await db
    .select({
      sessionId: studySessions.id,
      studyId: studySessions.studyId,
      startsAt: studySessions.startsAt,
      location: studySessions.location,
      participantCode: participants.code,
    })
    .from(studySessions)
    .leftJoin(enrollments, eq(studySessions.enrollmentId, enrollments.id))
    .leftJoin(participants, eq(enrollments.participantId, participants.id))
    .where(
      and(
        inArray(studySessions.studyId, studyIds),
        eq(studySessions.status, "booked"),
        gt(studySessions.startsAt, now),
        lte(studySessions.startsAt, horizon),
      ),
    )
    .orderBy(asc(studySessions.startsAt));
  return rows.map((row) => ({
    ...row,
    studyName: studyNames.get(row.studyId) ?? "study",
  }));
}

/** Not-done milestones already past due, oldest first. */
async function overdueMilestones(
  db: Db,
  studyIds: string[],
  studyNames: Map<string, string>,
  now: Date,
): Promise<OverdueMilestone[]> {
  const today = new Date(now.toISOString().slice(0, 10));
  const rows = await db
    .select({
      milestoneId: milestones.id,
      studyId: milestones.studyId,
      title: milestones.title,
      dueOn: milestones.dueOn,
      status: milestones.status,
    })
    .from(milestones)
    .where(and(ne(milestones.status, "done"), lte(milestones.dueOn, today)))
    .orderBy(asc(milestones.dueOn));
  return rows
    .filter((row) =>
      row.dueOn !== null &&
      (row.studyId === null || studyIds.includes(row.studyId))
    )
    .map((row) => ({
      milestoneId: row.milestoneId,
      studyId: row.studyId,
      studyName: row.studyId ? studyNames.get(row.studyId) ?? null : null,
      title: row.title,
      dueOn: row.dueOn!,
      status: row.status,
    }));
}

/** The dashboard's health snapshot, scoped to studies visible to `member`. */
export async function healthSnapshot(
  db: Db,
  member: Member,
  opts: { now?: Date; horizonDays?: number } = {},
): Promise<HealthSnapshot> {
  const now = opts.now ?? new Date();
  const visible = await listStudiesFor(db, member);
  const live = visible.filter((s) => LIVE_STATES.includes(s.study.status));
  const names = new Map(visible.map((s) => [s.study.id, s.study.name]));
  const liveIds = live.map((s) => s.study.id);

  const progress: StudyProgress[] = [];
  for (const { study } of live) {
    const funnel = await studyFunnel(db, study);
    progress.push({
      studyId: study.id,
      studyName: study.name,
      status: study.status,
      enrolled: funnel.overall.count,
      target: funnel.overall.target,
    });
  }

  return {
    progress,
    upcoming: await upcomingSessions(
      db,
      liveIds,
      names,
      opts.horizonDays ?? 7,
      now,
    ),
    overdue: await overdueMilestones(
      db,
      visible.map((s) => s.study.id),
      names,
      now,
    ),
  };
}
