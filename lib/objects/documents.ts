// Document domain logic (spec §3.3): versioned documents with a review
// workflow (draft → internal review → submitted → approved / revisions)
// and reviewer comments. Visibility follows the parent project. Recording
// "approved" is PI-only — it will gate recruiting (Phase 1.7).
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Document,
  type DocumentComment,
  documentComments,
  documents,
  type DocumentVersion,
  documentVersions,
  type Member,
  members,
  type Project,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { hasRole } from "../auth/roles.ts";
import { getProjectFor } from "./projects.ts";
import type { AuditCtx } from "./studies.ts";

export type DocumentStatus = Document["reviewStatus"];
export type DocumentKind = Document["kind"];

export class DocumentError extends Error {}

export const DOCUMENT_KINDS: DocumentKind[] = [
  "irb_protocol",
  "consent_form",
  "recruitment_material",
  "debrief",
  "amendment",
  "other",
];

/** Allowed review-status transitions. Approved is terminal: revising an
 * approved document means adding a version, which resets to draft. */
const TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  draft: ["internal_review", "submitted"],
  internal_review: ["draft", "submitted"],
  submitted: ["approved", "revisions_requested"],
  approved: [],
  revisions_requested: ["draft"],
};

export function allowedDocumentTransitions(
  status: DocumentStatus,
): DocumentStatus[] {
  return TRANSITIONS[status];
}

export interface NewVersionInput {
  /** In-app text content (diffable) … */
  content?: string;
  /** … or an uploaded file already stored in the files bucket. */
  fileKey?: string;
  fileName?: string;
  changeRationale?: string;
}

function validateVersionInput(input: NewVersionInput) {
  const hasContent = (input.content ?? "").trim() !== "";
  const hasFile = !!input.fileKey;
  if (hasContent === hasFile) {
    throw new DocumentError(
      "A version needs either text content or an uploaded file (not both).",
    );
  }
}

/** Document + project if visible to `member`; null otherwise. */
export async function getDocumentFor(
  db: Db,
  member: Member,
  documentId: string,
): Promise<{ document: Document; project: Project } | null> {
  const document = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!document) return null;
  const project = await getProjectFor(db, member, document.projectId);
  return project ? { document, project } : null;
}

export async function listDocumentsOfProject(
  db: Db,
  projectId: string,
): Promise<Document[]> {
  return await db
    .select()
    .from(documents)
    .where(eq(documents.projectId, projectId))
    .orderBy(asc(documents.title));
}

export async function listDocumentsOfStudy(
  db: Db,
  studyId: string,
): Promise<Document[]> {
  return await db
    .select()
    .from(documents)
    .where(eq(documents.studyId, studyId))
    .orderBy(asc(documents.title));
}

export async function createDocument(
  db: Db,
  opts: {
    project: Project;
    study?: Study | null;
    title: string;
    kind: DocumentKind;
    initialVersion: NewVersionInput;
    createdBy: Member;
  } & AuditCtx,
): Promise<Document> {
  const title = opts.title.trim();
  if (!title) throw new DocumentError("Document title is required.");
  validateVersionInput(opts.initialVersion);

  return await db.transaction(async (tx) => {
    const [document] = await tx
      .insert(documents)
      .values({
        projectId: opts.project.id,
        studyId: opts.study?.id ?? null,
        title,
        kind: opts.kind,
        currentVersion: 1,
        createdBy: opts.createdBy.id,
      })
      .returning();
    await tx.insert(documentVersions).values({
      documentId: document.id,
      versionNumber: 1,
      content: opts.initialVersion.content?.trim() || null,
      fileKey: opts.initialVersion.fileKey ?? null,
      fileName: opts.initialVersion.fileName ?? null,
      createdBy: opts.createdBy.id,
    });
    await audit(tx, {
      action: "document.created",
      actorId: opts.createdBy.id,
      objectType: "document",
      objectId: document.id,
      details: { kind: opts.kind, projectId: opts.project.id },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return document;
  });
}

/** Adds a version and resets review status to draft (a revision is never
 * implicitly approved). From v2 on, a change rationale is required. */
export async function addVersion(
  db: Db,
  opts: {
    document: Document;
    version: NewVersionInput;
    actor: Member;
  } & AuditCtx,
): Promise<Document> {
  validateVersionInput(opts.version);
  if (!(opts.version.changeRationale ?? "").trim()) {
    throw new DocumentError(
      "A change rationale is required for a new version.",
    );
  }

  return await db.transaction(async (tx) => {
    const next = opts.document.currentVersion + 1;
    await tx.insert(documentVersions).values({
      documentId: opts.document.id,
      versionNumber: next,
      content: opts.version.content?.trim() || null,
      fileKey: opts.version.fileKey ?? null,
      fileName: opts.version.fileName ?? null,
      changeRationale: opts.version.changeRationale!.trim(),
      createdBy: opts.actor.id,
    });
    const [updated] = await tx
      .update(documents)
      .set({
        currentVersion: next,
        reviewStatus: "draft",
        updatedAt: new Date(),
      })
      .where(eq(documents.id, opts.document.id))
      .returning();
    await audit(tx, {
      action: "document.version_added",
      actorId: opts.actor.id,
      objectType: "document",
      objectId: opts.document.id,
      details: { version: next },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return updated;
  });
}

export async function transitionDocument(
  db: Db,
  opts: { document: Document; to: DocumentStatus; actor: Member } & AuditCtx,
): Promise<Document> {
  const from = opts.document.reviewStatus;
  if (!TRANSITIONS[from].includes(opts.to)) {
    throw new DocumentError(
      `Cannot move a document from "${from}" to "${opts.to}".`,
    );
  }
  // Recording IRB approval is compliance-critical and PI-only: it will
  // unlock recruiting for IRB-reviewed studies (Phase 1.7).
  if (opts.to === "approved" && !hasRole(opts.actor.role, "pi")) {
    throw new DocumentError("Only the PI can record an approval.");
  }
  const [updated] = await db
    .update(documents)
    .set({ reviewStatus: opts.to, updatedAt: new Date() })
    .where(eq(documents.id, opts.document.id))
    .returning();
  await audit(db, {
    action: "document.status_changed",
    actorId: opts.actor.id,
    objectType: "document",
    objectId: opts.document.id,
    details: { from, to: opts.to },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return updated;
}

export async function listVersions(
  db: Db,
  documentId: string,
): Promise<DocumentVersion[]> {
  return await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.versionNumber));
}

export async function getVersion(
  db: Db,
  documentId: string,
  versionNumber: number,
): Promise<DocumentVersion | null> {
  const version = await db.query.documentVersions.findFirst({
    where: and(
      eq(documentVersions.documentId, documentId),
      eq(documentVersions.versionNumber, versionNumber),
    ),
  });
  return version ?? null;
}

export async function addComment(
  db: Db,
  opts: {
    document: Document;
    author: Member;
    body: string;
    versionNumber?: number | null;
  },
): Promise<DocumentComment> {
  const body = opts.body.trim();
  if (!body) throw new DocumentError("Comment cannot be empty.");
  const [comment] = await db
    .insert(documentComments)
    .values({
      documentId: opts.document.id,
      versionNumber: opts.versionNumber ?? null,
      authorId: opts.author.id,
      body,
    })
    .returning();
  return comment;
}

export async function listComments(
  db: Db,
  documentId: string,
): Promise<{ comment: DocumentComment; author: Member }[]> {
  const rows = await db
    .select({ comment: documentComments, author: members })
    .from(documentComments)
    .innerJoin(members, eq(documentComments.authorId, members.id))
    .where(eq(documentComments.documentId, documentId))
    .orderBy(asc(documentComments.createdAt));
  return rows;
}

/** Storage key for an uploaded document version file. */
export function documentFileKey(
  documentId: string,
  versionNumber: number,
  fileName: string,
): string {
  const safe = fileName.replaceAll(/[^\w.\-]/g, "_").slice(0, 120);
  return `documents/${documentId}/v${versionNumber}/${safe}`;
}
