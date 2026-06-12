// Project domain logic (spec §2.1, §3.1). Visibility: the PI sees every
// project; everyone else sees only projects they are a member of
// (spec §3.10). All mutations are audited by the callers' route handlers
// passing through audit() here, so an unrecorded change cannot succeed.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Member,
  members,
  type Project,
  projectMembers,
  projects,
} from "../db/schema.ts";
import { hasRole } from "../auth/roles.ts";
import { audit } from "../audit/log.ts";

export class ProjectError extends Error {}

export interface AuditCtx {
  requestId?: string;
  ip?: string;
}

/** Projects visible to `member`: all for the PI, assigned otherwise. */
export async function listProjectsFor(
  db: Db,
  member: Member,
): Promise<Project[]> {
  if (hasRole(member.role, "pi")) {
    return await db.select().from(projects);
  }
  const rows = await db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.memberId, member.id));
  return rows.map((r) => r.project);
}

/** Project if it exists AND `member` may see it; null otherwise. */
export async function getProjectFor(
  db: Db,
  member: Member,
  projectId: string,
): Promise<Project | null> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) return null;
  if (hasRole(member.role, "pi")) return project;
  const membership = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.memberId, member.id),
    ),
  });
  return membership ? project : null;
}

/** Creating members join their own project automatically. */
export async function createProject(
  db: Db,
  opts: { name: string; description?: string; createdBy: Member } & AuditCtx,
): Promise<Project> {
  const name = opts.name.trim();
  if (!name) throw new ProjectError("Project name is required.");

  return await db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        name,
        description: opts.description?.trim() ?? "",
        createdBy: opts.createdBy.id,
      })
      .returning();
    await tx.insert(projectMembers).values({
      projectId: project.id,
      memberId: opts.createdBy.id,
    });
    await audit(tx, {
      action: "project.created",
      actorId: opts.createdBy.id,
      objectType: "project",
      objectId: project.id,
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return project;
  });
}

export async function updateProject(
  db: Db,
  opts: {
    project: Project;
    name: string;
    description: string;
    actor: Member;
  } & AuditCtx,
): Promise<Project> {
  const name = opts.name.trim();
  if (!name) throw new ProjectError("Project name is required.");
  if (opts.project.status !== "active") {
    throw new ProjectError("Archived projects cannot be edited.");
  }

  const [updated] = await db
    .update(projects)
    .set({ name, description: opts.description.trim(), updatedAt: new Date() })
    .where(eq(projects.id, opts.project.id))
    .returning();
  await audit(db, {
    action: "project.updated",
    actorId: opts.actor.id,
    objectType: "project",
    objectId: opts.project.id,
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function setProjectStatus(
  db: Db,
  opts: {
    project: Project;
    status: Project["status"];
    actor: Member;
  } & AuditCtx,
): Promise<Project> {
  const [updated] = await db
    .update(projects)
    .set({ status: opts.status, updatedAt: new Date() })
    .where(eq(projects.id, opts.project.id))
    .returning();
  await audit(db, {
    action: opts.status === "archived"
      ? "project.archived"
      : "project.unarchived",
    actorId: opts.actor.id,
    objectType: "project",
    objectId: opts.project.id,
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function listProjectMembers(
  db: Db,
  projectId: string,
): Promise<Member[]> {
  const rows = await db
    .select({ member: members })
    .from(projectMembers)
    .innerJoin(members, eq(projectMembers.memberId, members.id))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(members.name);
  return rows.map((r) => r.member);
}

export async function addProjectMember(
  db: Db,
  opts: { project: Project; memberId: string; actor: Member } & AuditCtx,
): Promise<void> {
  const inserted = await db
    .insert(projectMembers)
    .values({ projectId: opts.project.id, memberId: opts.memberId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return; // already a member — nothing to audit
  await audit(db, {
    action: "project.member_added",
    actorId: opts.actor.id,
    objectType: "project",
    objectId: opts.project.id,
    details: { memberId: opts.memberId },
    requestId: opts.requestId,
    ip: opts.ip,
  });
}

export async function removeProjectMember(
  db: Db,
  opts: { project: Project; memberId: string; actor: Member } & AuditCtx,
): Promise<void> {
  const removed = await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, opts.project.id),
        eq(projectMembers.memberId, opts.memberId),
      ),
    )
    .returning();
  if (removed.length === 0) return;
  await audit(db, {
    action: "project.member_removed",
    actorId: opts.actor.id,
    objectType: "project",
    objectId: opts.project.id,
    details: { memberId: opts.memberId },
    requestId: opts.requestId,
    ip: opts.ip,
  });
}

/** Projects a given member belongs to (e.g. for their detail page). */
export async function listProjectsOfMember(
  db: Db,
  memberId: string,
): Promise<Project[]> {
  const rows = await db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.memberId, memberId))
    .orderBy(projects.name);
  return rows.map((r) => r.project);
}

/** Members not yet on the project (for the add-member picker). */
export async function listAddableMembers(
  db: Db,
  projectId: string,
): Promise<Member[]> {
  const current = await db
    .select({ memberId: projectMembers.memberId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  const ids = current.map((r) => r.memberId);
  const all = await db.select().from(members).orderBy(members.name);
  return ids.length === 0 ? all : all.filter((m) => !ids.includes(m.id));
}
