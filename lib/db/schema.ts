// Database schema (Drizzle). drizzle-kit loads this file when generating
// migrations; the encryptedText import is safe because its keyring is
// resolved lazily at query time, never at module load.
import {
  boolean,
  date,
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
import { encryptedText } from "./encrypted.ts";

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
  /** Required when irb_exempt: the IRB's exemption determination/reference. */
  irbExemptionReference: text("irb_exemption_reference").notNull().default(""),
  /** Required when internal_pilot: the PI's recorded justification. */
  pilotJustification: text("pilot_justification").notNull().default(""),
  // IRB approval metadata (spec §3.3): drives expiry warnings and the
  // recruiting guard. Recorded by the PI; never copied on duplication.
  irbProtocolNumber: text("irb_protocol_number").notNull().default(""),
  irbApprovedOn: date("irb_approved_on", { mode: "date" }),
  irbExpiresOn: date("irb_expires_on", { mode: "date" }),
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

// Participants (spec §2.1, §3.4): the lab-wide pool. Records persist
// across studies for re-recruitment. PII (name, notes, channel values)
// is app-layer encrypted transparently via the encryptedText column type;
// demographics used for filtering stay plaintext. The pseudonymous `code`
// is what appears in datasets, exports, Discord and Notion.
export const participants = pgTable("participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Short pseudonymous code used everywhere PII must not appear. */
  code: text("code").notNull().unique(),
  /** PII: participant name (encrypted at rest). */
  name: encryptedText("name").notNull(),
  /** PII: free-text notes — may contain PII (encrypted at rest). */
  notes: encryptedText("notes").notNull().default(""),
  yearOfBirth: integer("year_of_birth"),
  gender: text("gender").notNull().default(""),
  /** Where this person was recruited from (flyer, class, friend, …). */
  source: text("source").notNull().default(""),
  doNotContact: boolean("do_not_contact").notNull().default(false),
  /** Member who added the record; null when self-registered via a
   * public screener (no member actor). */
  createdBy: uuid("created_by").references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Participant = typeof participants.$inferSelect;

export const contactChannelKind = pgEnum("contact_channel_kind", [
  "email",
  "telegram",
  "phone",
  "paypal",
  "prolific",
]);

export type ContactChannelKind = (typeof contactChannelKind.enumValues)[number];

export const contactChannels = pgTable("contact_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  participantId: uuid("participant_id")
    .notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  kind: contactChannelKind("kind").notNull(),
  /** PII: the address / chat id / handle (encrypted at rest). */
  value: encryptedText("value").notNull(),
  /** Keyed blind index of the normalized value — dedup and lookup. */
  valueIndex: text("value_index").notNull(),
  verified: boolean("verified").notNull().default(false),
  isPreferred: boolean("is_preferred").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("contact_channels_participant_idx").on(table.participantId),
  index("contact_channels_value_index_idx").on(table.valueIndex),
]);

export type ContactChannel = typeof contactChannels.$inferSelect;

// Instruments (spec §2.1, §4 kept-feature 4): the lab-wide library of
// simple forms (screeners, consent add-ons, diary entries — item types,
// no branching) and records of external instruments (Qualtrics links).
// Versioned like documents: editing always creates a new version, so
// responses can reference the exact definition they were collected with.
export const instrumentKind = pgEnum("instrument_kind", [
  "simple_form",
  "external",
]);

export const instrumentPurpose = pgEnum("instrument_purpose", [
  "screener",
  "diary",
  "consent_addon",
  "other",
]);

export const instruments = pgTable("instruments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: instrumentKind("kind").notNull(),
  purpose: instrumentPurpose("purpose").notNull().default("other"),
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

export type Instrument = typeof instruments.$inferSelect;

// Simple forms carry `items`/`scoring` (validated by lib/objects/forms.ts);
// external records carry `externalUrl`. Both may note what changed.
export const instrumentVersions = pgTable("instrument_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instruments.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  items: jsonb("items").$type<unknown[]>(),
  scoring: jsonb("scoring").$type<unknown[]>(),
  externalUrl: text("external_url"),
  changeNote: text("change_note").notNull().default(""),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  unique("instrument_versions_version_unique").on(
    table.instrumentId,
    table.versionNumber,
  ),
]);

export type InstrumentVersion = typeof instrumentVersions.$inferSelect;

// Screeners (spec §3.4): a study's public recruitment form — a pinned
// version of a simple-form instrument plus eligibility rules. The page
// lives at p/[token]/screener; the token is an opaque capability stored
// here (pause or regenerate to revoke). Internal Pilot studies never get
// one (spec §3.3: no public recruitment).
export const screenerStatus = pgEnum("screener_status", ["open", "paused"]);

export const screeners = pgTable("screeners", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .unique()
    .references(() => studies.id, { onDelete: "cascade" }),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instruments.id),
  /** Pinned at configure time; revising the instrument never silently
   * changes a live screener. */
  instrumentVersionNumber: integer("instrument_version_number").notNull(),
  /** Eligibility rules (validated by lib/objects/eligibility.ts). */
  eligibility: jsonb("eligibility").$type<unknown[]>().notNull(),
  status: screenerStatus("status").notNull().default("open"),
  token: text("token").notNull().unique(),
  /** Public page views, for funnel stats (viewed → screened → …). */
  views: integer("views").notNull().default(0),
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

export type Screener = typeof screeners.$inferSelect;

// Enrollments (spec §2.1): a participant's involvement in one study.
// Created here by screeners (2.4); the full lifecycle with transitions,
// manual enrollment and the pilot flag lands in 2.5.
export const enrollmentStatus = pgEnum("enrollment_status", [
  "screened",
  "eligible",
  "consented",
  "active",
  "completed",
  "withdrawn",
  "excluded",
]);

export const enrollments = pgTable("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id")
    .notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  status: enrollmentStatus("status").notNull().default("screened"),
  /** Pilot data quarantine (spec §4 kept-feature 5): excluded from
   * datasets, quotas and publishable exports by default. */
  isPilot: boolean("is_pilot").notNull().default(false),
  conditionId: uuid("condition_id").references(() => conditions.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  unique("enrollments_study_participant_unique").on(
    table.studyId,
    table.participantId,
  ),
]);

export type Enrollment = typeof enrollments.$inferSelect;

// Screener answers are jsonb, NOT encrypted: screener questions must not
// ask for PII (contact details go through Participant/ContactChannel on
// the same submission). Responses pin the instrument version they were
// collected with.
export const screenerResponses = pgTable("screener_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  screenerId: uuid("screener_id")
    .notNull()
    .references(() => screeners.id, { onDelete: "cascade" }),
  enrollmentId: uuid("enrollment_id")
    .notNull()
    .references(() => enrollments.id, { onDelete: "cascade" }),
  instrumentVersionNumber: integer("instrument_version_number").notNull(),
  answers: jsonb("answers").$type<Record<string, unknown>>().notNull(),
  eligible: boolean("eligible").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ScreenerResponse = typeof screenerResponses.$inferSelect;

// Consents (spec §4 kept-feature 1): a participant's signed agreement to
// a specific APPROVED version of the study's consent Document. Amendments
// (new approved versions) leave old rows intact and outdated — re-consent
// inserts a new row, so the history of what was agreed to is immutable.
export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  enrollmentId: uuid("enrollment_id")
    .notNull()
    .references(() => enrollments.id, { onDelete: "cascade" }),
  documentId: uuid("document_id")
    .notNull()
    // Cascade: documents are only ever deleted via project deletion,
    // which removes the enrollments (and these rows) anyway.
    .references(() => documents.id, { onDelete: "cascade" }),
  documentVersionNumber: integer("document_version_number").notNull(),
  /** PII: typed-name e-signature (encrypted at rest). */
  signatureName: encryptedText("signature_name").notNull(),
  /** May we contact this person about future studies? (spec §4 #1) */
  consentToRecontact: boolean("consent_to_recontact").notNull().default(false),
  signedAt: timestamp("signed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  unique("consents_enrollment_version_unique").on(
    table.enrollmentId,
    table.documentId,
    table.documentVersionNumber,
  ),
  index("consents_enrollment_idx").on(table.enrollmentId),
]);

export type Consent = typeof consents.$inferSelect;

// Milestones / Tasks (spec §2.1, §3.7): timeline items with owners, due
// dates and dependencies; belong to a Study or to the Project itself.
// "Blocked" is derived (an unfinished dependency), never stored.
export const milestoneStatus = pgEnum("milestone_status", [
  "pending",
  "in_progress",
  "done",
]);

export const milestones = pgTable("milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** Null for project-level milestones. */
  studyId: uuid("study_id").references(() => studies.id, {
    onDelete: "cascade",
  }),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  ownerId: uuid("owner_id").references(() => members.id, {
    onDelete: "set null",
  }),
  startsOn: date("starts_on", { mode: "date" }),
  dueOn: date("due_on", { mode: "date" }),
  status: milestoneStatus("status").notNull().default("pending"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => members.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("milestones_project_idx").on(table.projectId),
  index("milestones_study_idx").on(table.studyId),
]);

export type Milestone = typeof milestones.$inferSelect;

export const milestoneDependencies = pgTable("milestone_dependencies", {
  /** The milestone that is blocked … */
  milestoneId: uuid("milestone_id")
    .notNull()
    .references(() => milestones.id, { onDelete: "cascade" }),
  /** … until this one is done. */
  dependsOnId: uuid("depends_on_id")
    .notNull()
    .references(() => milestones.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.milestoneId, table.dependsOnId] }),
]);

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
