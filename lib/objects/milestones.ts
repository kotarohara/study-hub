// Milestones / Tasks (spec §3.7): CRUD with owners and due dates,
// dependencies with blocking ("can't start recruiting before IRB
// approval"), and methodology templates. The Gantt island (1.10) renders
// what this module manages.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Member,
  members,
  type Milestone,
  milestoneDependencies,
  milestones,
  type Project,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getProjectFor } from "./projects.ts";
import type { AuditCtx, Methodology } from "./studies.ts";

export type MilestoneStatus = Milestone["status"];

export class MilestoneError extends Error {}

export interface DependencyEdge {
  /** The blocked milestone … */
  from: string;
  /** … which depends on this one. */
  to: string;
}

/** True if adding `newFrom depends-on newTo` would create a cycle. */
export function wouldCreateCycle(
  edges: DependencyEdge[],
  newFrom: string,
  newTo: string,
): boolean {
  if (newFrom === newTo) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  // Cycle iff newTo already (transitively) depends on newFrom.
  const stack = [newTo];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === newFrom) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export interface MilestoneWithMeta {
  milestone: Milestone;
  owner: Member | null;
  /** Ids of milestones this one depends on. */
  dependsOn: string[];
  /** Derived: some dependency is not done. */
  blocked: boolean;
}

function sortKey(m: Milestone): string {
  // Due-dated first (by date), then undated by creation time.
  return m.dueOn
    ? `0-${m.dueOn.toISOString()}`
    : `1-${m.createdAt.toISOString()}`;
}

async function withMeta(
  db: Db,
  rows: Milestone[],
): Promise<MilestoneWithMeta[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((m) => m.id);
  const deps = await db
    .select()
    .from(milestoneDependencies)
    .where(inArray(milestoneDependencies.milestoneId, ids));
  const ownerIds = [
    ...new Set(rows.flatMap((m) => m.ownerId ? [m.ownerId] : [])),
  ];
  const owners = ownerIds.length === 0 ? [] : await db
    .select()
    .from(members)
    .where(inArray(members.id, ownerIds));
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const statusById = new Map(rows.map((m) => [m.id, m.status]));

  return rows
    .map((milestone) => {
      const dependsOn = deps
        .filter((d) => d.milestoneId === milestone.id)
        .map((d) => d.dependsOnId);
      return {
        milestone,
        owner: milestone.ownerId
          ? ownerById.get(milestone.ownerId) ?? null
          : null,
        dependsOn,
        // A dependency outside `rows` (cross-study within the project) is
        // looked up conservatively as blocking-unknown → treat as not done
        // only if we know its status; unknown ids do not block.
        blocked: dependsOn.some((id) => {
          const status = statusById.get(id);
          return status !== undefined && status !== "done";
        }),
      };
    })
    .sort((a, b) => sortKey(a.milestone).localeCompare(sortKey(b.milestone)));
}

export async function listMilestonesOfStudy(
  db: Db,
  studyId: string,
): Promise<MilestoneWithMeta[]> {
  const rows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.studyId, studyId))
    .orderBy(asc(milestones.createdAt));
  return await withMeta(db, rows);
}

/** Roll-up: the project's own milestones plus all of its studies'. */
export async function listMilestonesOfProject(
  db: Db,
  projectId: string,
): Promise<MilestoneWithMeta[]> {
  const rows = await db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(asc(milestones.createdAt));
  return await withMeta(db, rows);
}

/** Milestone + project if visible to `member`; null otherwise. */
export async function getMilestoneFor(
  db: Db,
  member: Member,
  milestoneId: string,
): Promise<{ milestone: Milestone; project: Project } | null> {
  const milestone = await db.query.milestones.findFirst({
    where: eq(milestones.id, milestoneId),
  });
  if (!milestone) return null;
  const project = await getProjectFor(db, member, milestone.projectId);
  return project ? { milestone, project } : null;
}

function validateDates(startsOn: Date | null, dueOn: Date | null) {
  if (startsOn && dueOn && dueOn < startsOn) {
    throw new MilestoneError("The due date cannot be before the start date.");
  }
}

export async function createMilestone(
  db: Db,
  opts: {
    project: Project;
    study?: Study | null;
    title: string;
    notes?: string;
    ownerId?: string | null;
    startsOn?: Date | null;
    dueOn?: Date | null;
    createdBy: Member;
  } & AuditCtx,
): Promise<Milestone> {
  const title = opts.title.trim();
  if (!title) throw new MilestoneError("Milestone title is required.");
  validateDates(opts.startsOn ?? null, opts.dueOn ?? null);

  return await db.transaction(async (tx) => {
    const [milestone] = await tx
      .insert(milestones)
      .values({
        projectId: opts.project.id,
        studyId: opts.study?.id ?? null,
        title,
        notes: opts.notes?.trim() ?? "",
        ownerId: opts.ownerId || null,
        startsOn: opts.startsOn ?? null,
        dueOn: opts.dueOn ?? null,
        createdBy: opts.createdBy.id,
      })
      .returning();
    await audit(tx, {
      action: "milestone.created",
      actorId: opts.createdBy.id,
      objectType: "milestone",
      objectId: milestone.id,
      details: { projectId: opts.project.id, studyId: opts.study?.id ?? null },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return milestone;
  });
}

export async function updateMilestone(
  db: Db,
  opts: {
    milestone: Milestone;
    title: string;
    notes: string;
    ownerId: string | null;
    startsOn: Date | null;
    dueOn: Date | null;
    actor: Member;
  } & AuditCtx,
): Promise<Milestone> {
  const title = opts.title.trim();
  if (!title) throw new MilestoneError("Milestone title is required.");
  validateDates(opts.startsOn, opts.dueOn);
  const [updated] = await db
    .update(milestones)
    .set({
      title,
      notes: opts.notes.trim(),
      ownerId: opts.ownerId || null,
      startsOn: opts.startsOn,
      dueOn: opts.dueOn,
      updatedAt: new Date(),
    })
    .where(eq(milestones.id, opts.milestone.id))
    .returning();
  return updated;
}

/** Date-only update used by drag-to-reschedule on the Gantt. */
export async function rescheduleMilestone(
  db: Db,
  opts: {
    milestone: Milestone;
    startsOn: Date | null;
    dueOn: Date | null;
    actor: Member;
  },
): Promise<Milestone> {
  validateDates(opts.startsOn, opts.dueOn);
  const [updated] = await db
    .update(milestones)
    .set({ startsOn: opts.startsOn, dueOn: opts.dueOn, updatedAt: new Date() })
    .where(eq(milestones.id, opts.milestone.id))
    .returning();
  return updated;
}

/** Status changes respect blocking: a milestone with an unfinished
 * dependency cannot be started or completed. */
export async function setMilestoneStatus(
  db: Db,
  opts:
    & { milestone: Milestone; status: MilestoneStatus; actor: Member }
    & AuditCtx,
): Promise<Milestone> {
  if (opts.status !== "pending") {
    const deps = await db
      .select()
      .from(milestoneDependencies)
      .where(eq(milestoneDependencies.milestoneId, opts.milestone.id));
    if (deps.length > 0) {
      const blockers = await db
        .select()
        .from(milestones)
        .where(
          and(
            inArray(milestones.id, deps.map((d) => d.dependsOnId)),
          ),
        );
      const unfinished = blockers.filter((b) => b.status !== "done");
      if (unfinished.length > 0) {
        throw new MilestoneError(
          `Blocked by: ${unfinished.map((b) => `"${b.title}"`).join(", ")}.`,
        );
      }
    }
  }
  const [updated] = await db
    .update(milestones)
    .set({ status: opts.status, updatedAt: new Date() })
    .where(eq(milestones.id, opts.milestone.id))
    .returning();
  await audit(db, {
    action: "milestone.status_changed",
    actorId: opts.actor.id,
    objectType: "milestone",
    objectId: opts.milestone.id,
    details: { from: opts.milestone.status, to: opts.status },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function deleteMilestone(
  db: Db,
  opts: { milestone: Milestone; actor: Member } & AuditCtx,
): Promise<void> {
  await db.delete(milestones).where(eq(milestones.id, opts.milestone.id));
  await audit(db, {
    action: "milestone.deleted",
    actorId: opts.actor.id,
    objectType: "milestone",
    objectId: opts.milestone.id,
    details: { title: opts.milestone.title },
    requestId: opts.requestId,
    ip: opts.ip,
  });
}

export async function addDependency(
  db: Db,
  opts:
    & { milestone: Milestone; dependsOnId: string; actor: Member }
    & AuditCtx,
): Promise<void> {
  const target = await db.query.milestones.findFirst({
    where: eq(milestones.id, opts.dependsOnId),
  });
  if (!target || target.projectId !== opts.milestone.projectId) {
    throw new MilestoneError(
      "Dependencies must point at a milestone in the same project.",
    );
  }
  const all = await db
    .select()
    .from(milestoneDependencies)
    .innerJoin(
      milestones,
      eq(milestoneDependencies.milestoneId, milestones.id),
    )
    .where(eq(milestones.projectId, opts.milestone.projectId));
  const edges: DependencyEdge[] = all.map((row) => ({
    from: row.milestone_dependencies.milestoneId,
    to: row.milestone_dependencies.dependsOnId,
  }));
  if (wouldCreateCycle(edges, opts.milestone.id, opts.dependsOnId)) {
    throw new MilestoneError("That dependency would create a cycle.");
  }
  await db
    .insert(milestoneDependencies)
    .values({ milestoneId: opts.milestone.id, dependsOnId: opts.dependsOnId })
    .onConflictDoNothing();
}

export async function removeDependency(
  db: Db,
  opts: { milestone: Milestone; dependsOnId: string },
): Promise<void> {
  await db
    .delete(milestoneDependencies)
    .where(
      and(
        eq(milestoneDependencies.milestoneId, opts.milestone.id),
        eq(milestoneDependencies.dependsOnId, opts.dependsOnId),
      ),
    );
}

/** Methodology templates (spec §3.7): ordered milestones, each depending
 * on the previous one. Dates are left for the team to fill in. */
export const MILESTONE_TEMPLATES: Record<Methodology, string[]> = {
  survey: [
    "Design finalized",
    "Survey instrument drafted (Qualtrics/Forms)",
    "IRB submission",
    "IRB approval",
    "Soft launch",
    "Data collection complete",
    "Analysis complete",
    "Write-up",
  ],
  crowdsourcing: [
    "Design finalized",
    "Task interface ready",
    "IRB submission",
    "IRB approval",
    "Pilot batch posted",
    "Full batches complete",
    "Analysis complete",
    "Write-up",
  ],
  lab_experiment: [
    "Design finalized",
    "Protocol script & apparatus ready",
    "IRB submission",
    "IRB approval",
    "Pilot session",
    "Recruitment started",
    "All sessions complete",
    "Analysis complete",
    "Write-up",
  ],
  diary_study: [
    "Design finalized",
    "Diary prompts & schedule defined",
    "IRB submission",
    "IRB approval",
    "Onboarding sessions",
    "Diary period complete",
    "Exit interviews complete",
    "Analysis complete",
    "Write-up",
  ],
  interview: [
    "Design finalized",
    "Interview guide ready",
    "IRB submission",
    "IRB approval",
    "Interviews scheduled",
    "Interviews complete",
    "Transcription & coding complete",
    "Write-up",
  ],
  field_deployment: [
    "Design finalized",
    "Deployment hardware/software ready",
    "IRB submission",
    "IRB approval",
    "Deployment installed",
    "Field period complete",
    "Data retrieval & cleanup",
    "Analysis complete",
    "Write-up",
  ],
};

/** Appends the methodology template as a sequentially-dependent chain. */
export async function applyMethodologyTemplate(
  db: Db,
  opts: { project: Project; study: Study; actor: Member } & AuditCtx,
): Promise<Milestone[]> {
  const titles = MILESTONE_TEMPLATES[opts.study.methodology];
  return await db.transaction(async (tx) => {
    const created: Milestone[] = [];
    for (const title of titles) {
      const [milestone] = await tx
        .insert(milestones)
        .values({
          projectId: opts.project.id,
          studyId: opts.study.id,
          title,
          createdBy: opts.actor.id,
        })
        .returning();
      const previous = created.at(-1);
      if (previous) {
        await tx.insert(milestoneDependencies).values({
          milestoneId: milestone.id,
          dependsOnId: previous.id,
        });
      }
      created.push(milestone);
    }
    await audit(tx, {
      action: "study.milestone_template_applied",
      actorId: opts.actor.id,
      objectType: "study",
      objectId: opts.study.id,
      details: { methodology: opts.study.methodology, count: created.length },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return created;
  });
}
