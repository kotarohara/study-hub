// Database schema (Drizzle). Keep this file free of Deno-specific imports —
// drizzle-kit (Node-based) loads it directly when generating migrations.
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Spec §3.10: PI > Researcher > Assistant > Collaborator.
export const memberRole = pgEnum("member_role", [
  "pi",
  "researcher",
  "assistant",
  "collaborator",
]);

// Lab member accounts (auth lands in Phase 0.4; password_hash stays null
// until an invite is accepted). Member emails are lab-internal account
// identifiers, not participant PII, so they are stored in plaintext.
export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: memberRole("role").notNull(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;

// Server-side sessions. Only a SHA-256 hash of the bearer token is stored,
// so a database leak does not yield usable session cookies.
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Session = typeof sessions.$inferSelect;

// PI invites (spec §3.10: PI-invites-members, no self-signup). The member
// row is created only when the invite is accepted.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  role: memberRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: uuid("invited_by")
    .notNull()
    .references(() => members.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Invite = typeof invites.$inferSelect;

// Projects (spec §2.1): the container for studies, documents and members.
// Projects have a simple active/archived lifecycle; the rich lifecycle
// (draft → IRB review → …) belongs to Studies.
export const projectStatus = pgEnum("project_status", ["active", "archived"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: projectStatus("status").notNull().default("active"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Project = typeof projects.$inferSelect;

// Which members belong to which project (spec §3.10: researchers and
// assistants act within their assigned projects; the PI sees everything).
export const projectMembers = pgTable("project_members", {
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  addedAt: timestamp("added_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.memberId] }),
]);

// Studies (spec §2.1): one experiment/survey/diary study with a design and
// lifecycle state. The lifecycle (§2.2 #5) drives which actions are enabled.
export const studyStatus = pgEnum("study_status", [
  "draft",
  "irb_review",
  "recruiting",
  "running",
  "analysis",
  "archived",
]);

export const studyMethodology = pgEnum("study_methodology", [
  "survey",
  "crowdsourcing",
  "lab_experiment",
  "diary_study",
  "interview",
  "field_deployment",
]);

// Oversight pathway (spec §3.3). The full selector with PI gate and pilot
// quarantine lands in Phase 1.6; until then studies are IRB-reviewed.
export const oversightPathway = pgEnum("oversight_pathway", [
  "irb_reviewed",
  "irb_exempt",
  "internal_pilot",
]);

export const designType = pgEnum("design_type", [
  "between",
  "within",
  "mixed",
]);

// Condition assignment (spec §3.2): random or manually-defined
// counterbalanced order. Enrollment wiring lands with Phase 2.5.
export const assignmentStrategy = pgEnum("assignment_strategy", [
  "random_balanced",
  "manual_sequence",
]);

export const studies = pgTable("studies", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  methodology: studyMethodology("methodology").notNull(),
  status: studyStatus("status").notNull().default("draft"),
  oversightPathway: oversightPathway("oversight_pathway")
    .notNull()
    .default("irb_reviewed"),
  /** Status before archiving, so unarchive can restore it. */
  archivedFrom: studyStatus("archived_from"),
  // Structured design fields (spec §3.2, simplified editor). List-like
  // fields are newline-separated plain text; the one-pager renders them.
  researchQuestions: text("research_questions").notNull().default(""),
  hypotheses: text("hypotheses").notNull().default(""),
  independentVariables: text("independent_variables").notNull().default(""),
  dependentVariables: text("dependent_variables").notNull().default(""),
  designType: designType("design_type"),
  targetN: integer("target_n"),
  exclusionCriteria: text("exclusion_criteria").notNull().default(""),
  /** Spec cut the Latin-square generator: the scheme is recorded as text. */
  counterbalancingScheme: text("counterbalancing_scheme").notNull().default(""),
  assignmentStrategy: assignmentStrategy("assignment_strategy")
    .notNull()
    .default("random_balanced"),
  /** Condition names in dispatch order (comma-separated), cycled. */
  assignmentSequence: text("assignment_sequence").notNull().default(""),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Study = typeof studies.$inferSelect;

// Experimental conditions (spec §2.1: Study has Conditions). Enrollments
// are assigned to conditions by the engine in Phase 1.4.
export const conditions = pgTable("conditions", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  unique("conditions_study_name_unique").on(table.studyId, table.name),
]);

export type Condition = typeof conditions.$inferSelect;

// Documents (spec §2.1, §3.3): IRB protocols, consent forms, recruitment
// material, debrief scripts, amendments — versioned, with review status.
export const documentKind = pgEnum("document_kind", [
  "irb_protocol",
  "consent_form",
  "recruitment_material",
  "debrief",
  "amendment",
  "other",
]);

export const documentStatus = pgEnum("document_status", [
  "draft",
  "internal_review",
  "submitted",
  "approved",
  "revisions_requested",
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Optional attachment to a specific study within the project. */
  studyId: uuid("study_id").references(() => studies.id, {
    onDelete: "cascade",
  }),
  title: text("title").notNull(),
  kind: documentKind("kind").notNull(),
  /** Review status of the CURRENT version; adding a version resets it to
   * draft — a new revision is never implicitly approved. */
  reviewStatus: documentStatus("review_status").notNull().default("draft"),
  currentVersion: integer("current_version").notNull().default(0),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Document = typeof documents.$inferSelect;

// Either in-app text (`content`, diffable) or an uploaded file (`fileKey`
// in the files bucket).
export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  content: text("content"),
  fileKey: text("file_key"),
  fileName: text("file_name"),
  /** Amendment workflow: why this version exists (required from v2 on). */
  changeRationale: text("change_rationale").notNull().default(""),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  unique("document_versions_doc_version_unique").on(
    table.documentId,
    table.versionNumber,
  ),
]);

export type DocumentVersion = typeof documentVersions.$inferSelect;

export const documentComments = pgTable("document_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  /** Version the comment refers to (null = the document in general). */
  versionNumber: integer("version_number"),
  authorId: uuid("author_id")
    .notNull()
    .references(() => members.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DocumentComment = typeof documentComments.$inferSelect;

// Append-only audit log (spec §4: PII views/exports, consent changes,
// deletions, payment approvals). Immutability is enforced in the database
// by triggers (see migration 0002) — UPDATE/DELETE/TRUNCATE raise.
// actor_id is deliberately NOT a foreign key: audit entries must outlive
// the members they reference. details must never contain PII.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  /** Member who acted; null for system or participant actions. */
  actorId: uuid("actor_id"),
  /** Namespaced verb, e.g. "auth.login", "pii.view", "payment.approve". */
  action: text("action").notNull(),
  objectType: text("object_type"),
  objectId: text("object_id"),
  details: jsonb("details").$type<Record<string, unknown>>(),
  requestId: text("request_id"),
  ip: text("ip"),
}, (table) => [
  index("audit_log_at_idx").on(table.at),
  index("audit_log_action_idx").on(table.action),
  index("audit_log_object_idx").on(table.objectType, table.objectId),
]);

export type AuditEntry = typeof auditLog.$inferSelect;
