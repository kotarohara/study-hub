// Study domain logic (spec §2.1, §3.1). Lifecycle: draft → IRB review →
// recruiting → running → analysis → archived; transitions are validated
// against an explicit map and audited. Visibility follows the parent
// project (PI sees all; others see studies of assigned projects).
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  conditions,
  documents,
  documentVersions,
  type Member,
  type Project,
  projects,
  studies,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { hasRole } from "../auth/roles.ts";
import { getProjectFor, listProjectsFor } from "./projects.ts";

export type StudyStatus = Study["status"];
export type Methodology = Study["methodology"];

export class StudyError extends Error {}

export const METHODOLOGIES: Methodology[] = [
  "survey",
  "crowdsourcing",
  "lab_experiment",
  "diary_study",
  "interview",
  "field_deployment",
];

/** The forward path shown by the lifecycle stepper. */
export const STUDY_STEPS: readonly StudyStatus[] = [
  "draft",
  "irb_review",
  "recruiting",
  "running",
  "analysis",
];

/** Allowed status transitions (archive/unarchive handled separately).
 * NOTE Phase 1.7 adds the recruiting guard: an IRB-reviewed study may only
 * enter "recruiting" once an approved consent Document exists. */
const TRANSITIONS: Record<StudyStatus, StudyStatus[]> = {
  draft: ["irb_review"],
  irb_review: ["draft", "recruiting"],
  recruiting: ["running"],
  running: ["analysis"],
  analysis: [],
  archived: [],
};

export function allowedTransitions(status: StudyStatus): StudyStatus[] {
  return TRANSITIONS[status];
}

/** Lifecycle states in which the design (name/description/…) is editable. */
export const EDITABLE_STATES: readonly StudyStatus[] = ["draft", "irb_review"];

export interface AuditCtx {
  requestId?: string;
  ip?: string;
}

// ---------- Oversight pathway (spec §3.3) ----------

export type OversightPathway = Study["oversightPathway"];

export function isPilotStudy(study: Study): boolean {
  return study.oversightPathway === "internal_pilot";
}

export interface PathwayInput {
  pathway: OversightPathway;
  exemptionReference?: string;
  justification?: string;
}

/**
 * Validates a pathway declaration (spec §3.3): IRB-exempt requires the
 * exemption reference; Internal Pilot requires PI confirmation (the actor
 * IS the PI) plus a recorded justification. StudyHub records the declared
 * status; whether a pilot truly needs no review is the institution's call —
 * which is exactly why the choice is PI-gated and audited.
 */
export function validatePathway(
  input: PathwayInput,
  actorRole: Member["role"],
): { irbExemptionReference: string; pilotJustification: string } {
  const reference = input.exemptionReference?.trim() ?? "";
  const justification = input.justification?.trim() ?? "";

  switch (input.pathway) {
    case "irb_reviewed":
      return { irbExemptionReference: "", pilotJustification: "" };
    case "irb_exempt":
      if (!reference) {
        throw new StudyError(
          "IRB-exempt studies require the exemption reference/determination.",
        );
      }
      return { irbExemptionReference: reference, pilotJustification: "" };
    case "internal_pilot":
      if (!hasRole(actorRole, "pi")) {
        throw new StudyError(
          "Only the PI can declare an Internal Pilot (no IRB review).",
        );
      }
      if (!justification) {
        throw new StudyError(
          "Internal Pilots require a short justification, recorded in the audit log.",
        );
      }
      return { irbExemptionReference: "", pilotJustification: justification };
  }
}

/** Changes the pathway of an existing study. PI-only, and only while the
 * design is still editable — after that, "Promote to full study" (1.8) is
 * the way out of a pilot. */
export async function setOversightPathway(
  db: Db,
  opts: { study: Study; input: PathwayInput; actor: Member } & AuditCtx,
): Promise<Study> {
  if (!hasRole(opts.actor.role, "pi")) {
    throw new StudyError("Only the PI can change the oversight pathway.");
  }
  if (!EDITABLE_STATES.includes(opts.study.status)) {
    throw new StudyError(
      `The pathway of a study in "${opts.study.status}" cannot be changed.`,
    );
  }
  const fields = validatePathway(opts.input, opts.actor.role);
  const [updated] = await db
    .update(studies)
    .set({
      oversightPathway: opts.input.pathway,
      ...fields,
      updatedAt: new Date(),
    })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.pathway_changed",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: {
      from: opts.study.oversightPathway,
      to: opts.input.pathway,
      ...(fields.irbExemptionReference
        ? { exemptionReference: fields.irbExemptionReference }
        : {}),
      ...(fields.pilotJustification
        ? { justification: fields.pilotJustification }
        : {}),
    },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export interface StudyWithProject {
  study: Study;
  project: Project;
}

export async function listStudiesFor(
  db: Db,
  member: Member,
): Promise<StudyWithProject[]> {
  const visibleProjects = await listProjectsFor(db, member);
  if (visibleProjects.length === 0) return [];
  const byId = new Map(visibleProjects.map((p) => [p.id, p]));
  const rows = await db
    .select()
    .from(studies)
    .where(inArray(studies.projectId, [...byId.keys()]));
  return rows.map((study) => ({ study, project: byId.get(study.projectId)! }));
}

/** Study + project if visible to `member`; null otherwise. */
export async function getStudyFor(
  db: Db,
  member: Member,
  studyId: string,
): Promise<StudyWithProject | null> {
  const study = await db.query.studies.findFirst({
    where: eq(studies.id, studyId),
  });
  if (!study) return null;
  const project = await getProjectFor(db, member, study.projectId);
  return project ? { study, project } : null;
}

export async function createStudy(
  db: Db,
  opts: {
    project: Project;
    name: string;
    description?: string;
    methodology: Methodology;
    /** Oversight pathway declared at creation (spec §3.3); defaults to
     * irb_reviewed. Internal Pilot requires the creator to be the PI. */
    pathway?: PathwayInput;
    createdBy: Member;
  } & AuditCtx,
): Promise<Study> {
  const name = opts.name.trim();
  if (!name) throw new StudyError("Study name is required.");
  if (opts.project.status !== "active") {
    throw new StudyError("Studies cannot be added to an archived project.");
  }
  const pathway: PathwayInput = opts.pathway ?? { pathway: "irb_reviewed" };
  const pathwayFields = validatePathway(pathway, opts.createdBy.role);

  return await db.transaction(async (tx) => {
    const [study] = await tx
      .insert(studies)
      .values({
        projectId: opts.project.id,
        name,
        description: opts.description?.trim() ?? "",
        methodology: opts.methodology,
        oversightPathway: pathway.pathway,
        ...pathwayFields,
        createdBy: opts.createdBy.id,
      })
      .returning();
    await audit(tx, {
      action: "study.created",
      actorId: opts.createdBy.id,
      objectType: "study",
      objectId: study.id,
      details: {
        projectId: opts.project.id,
        methodology: opts.methodology,
        pathway: pathway.pathway,
        ...(pathwayFields.pilotJustification
          ? { justification: pathwayFields.pilotJustification }
          : {}),
        ...(pathwayFields.irbExemptionReference
          ? { exemptionReference: pathwayFields.irbExemptionReference }
          : {}),
      },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return study;
  });
}

export async function updateStudy(
  db: Db,
  opts: {
    study: Study;
    name: string;
    description: string;
    actor: Member;
  } & AuditCtx,
): Promise<Study> {
  const name = opts.name.trim();
  if (!name) throw new StudyError("Study name is required.");
  if (!EDITABLE_STATES.includes(opts.study.status)) {
    throw new StudyError(
      `A study in "${opts.study.status}" cannot be edited.`,
    );
  }

  const [updated] = await db
    .update(studies)
    .set({ name, description: opts.description.trim(), updatedAt: new Date() })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.updated",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function transitionStudy(
  db: Db,
  opts: { study: Study; to: StudyStatus; actor: Member } & AuditCtx,
): Promise<Study> {
  const from = opts.study.status;
  if (!TRANSITIONS[from].includes(opts.to)) {
    throw new StudyError(`Cannot move a study from "${from}" to "${opts.to}".`);
  }
  const [updated] = await db
    .update(studies)
    .set({ status: opts.to, updatedAt: new Date() })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.status_changed",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: { from, to: opts.to },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function archiveStudy(
  db: Db,
  opts: { study: Study; actor: Member } & AuditCtx,
): Promise<Study> {
  if (opts.study.status === "archived") {
    throw new StudyError("Study is already archived.");
  }
  const [updated] = await db
    .update(studies)
    .set({
      status: "archived",
      archivedFrom: opts.study.status,
      updatedAt: new Date(),
    })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.archived",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: { from: opts.study.status },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function unarchiveStudy(
  db: Db,
  opts: { study: Study; actor: Member } & AuditCtx,
): Promise<Study> {
  if (opts.study.status !== "archived") {
    throw new StudyError("Study is not archived.");
  }
  const restoreTo = opts.study.archivedFrom ?? "draft";
  const [updated] = await db
    .update(studies)
    .set({ status: restoreTo, archivedFrom: null, updatedAt: new Date() })
    .where(eq(studies.id, opts.study.id))
    .returning();
  await audit(db, {
    action: "study.unarchived",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: { to: restoreTo },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

/**
 * Duplication is the primary path for "new study like the last one"
 * (spec §2.2 #6): copies the design — never participants or data — into a
 * fresh draft. Extend to copy documents (1.5) and milestones (1.9) as
 * those object types land.
 */
export async function duplicateStudy(
  db: Db,
  opts: { study: Study; actor: Member } & AuditCtx,
): Promise<Study> {
  // Duplicating a pilot reproduces its no-IRB declaration, so it carries the
  // same PI gate as creating one. "Promote to full study" (1.8) is the path
  // to an IRB-reviewed copy.
  if (isPilotStudy(opts.study) && !hasRole(opts.actor.role, "pi")) {
    throw new StudyError(
      "Only the PI can duplicate an Internal Pilot. Use “Promote to full study” for an IRB-reviewed copy.",
    );
  }
  return await db.transaction(async (tx) => {
    const [copy] = await tx
      .insert(studies)
      .values({
        projectId: opts.study.projectId,
        name: `${opts.study.name} (copy)`,
        description: opts.study.description,
        methodology: opts.study.methodology,
        oversightPathway: opts.study.oversightPathway,
        irbExemptionReference: opts.study.irbExemptionReference,
        pilotJustification: opts.study.pilotJustification,
        researchQuestions: opts.study.researchQuestions,
        hypotheses: opts.study.hypotheses,
        independentVariables: opts.study.independentVariables,
        dependentVariables: opts.study.dependentVariables,
        designType: opts.study.designType,
        targetN: opts.study.targetN,
        exclusionCriteria: opts.study.exclusionCriteria,
        counterbalancingScheme: opts.study.counterbalancingScheme,
        assignmentStrategy: opts.study.assignmentStrategy,
        assignmentSequence: opts.study.assignmentSequence,
        createdBy: opts.actor.id,
      })
      .returning();
    const sourceConditions = await tx
      .select()
      .from(conditions)
      .where(eq(conditions.studyId, opts.study.id));
    if (sourceConditions.length > 0) {
      await tx.insert(conditions).values(
        sourceConditions.map((c) => ({
          studyId: copy.id,
          name: c.name,
          position: c.position,
        })),
      );
    }
    // Copy study-attached documents: latest version becomes v1 of a fresh
    // DRAFT document — approval status never carries over to a new study.
    const sourceDocs = await tx
      .select()
      .from(documents)
      .where(eq(documents.studyId, opts.study.id));
    for (const doc of sourceDocs) {
      const latest = await tx.query.documentVersions.findFirst({
        where: and(
          eq(documentVersions.documentId, doc.id),
          eq(documentVersions.versionNumber, doc.currentVersion),
        ),
      });
      const [docCopy] = await tx
        .insert(documents)
        .values({
          projectId: doc.projectId,
          studyId: copy.id,
          title: doc.title,
          kind: doc.kind,
          currentVersion: 1,
          createdBy: opts.actor.id,
        })
        .returning();
      if (latest) {
        await tx.insert(documentVersions).values({
          documentId: docCopy.id,
          versionNumber: 1,
          content: latest.content,
          fileKey: latest.fileKey, // immutable blob, safe to share
          fileName: latest.fileName,
          changeRationale: `Duplicated from study "${opts.study.name}"`,
          createdBy: opts.actor.id,
        });
      }
    }
    await audit(tx, {
      action: "study.duplicated",
      actorId: opts.actor.id,
      objectType: "study",
      objectId: copy.id,
      details: { sourceStudyId: opts.study.id },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return copy;
  });
}

/** Studies inside one project (for the project detail Studies tab). */
export async function listStudiesOfProject(
  db: Db,
  projectId: string,
): Promise<Study[]> {
  return await db
    .select()
    .from(studies)
    .where(eq(studies.projectId, projectId))
    .orderBy(studies.name);
}

/** Project lookup for redirects after study creation. */
export async function getProjectOfStudy(
  db: Db,
  study: Study,
): Promise<Project | null> {
  return (await db.query.projects.findFirst({
    where: eq(projects.id, study.projectId),
  })) ?? null;
}
