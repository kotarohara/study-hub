// Database schema (Drizzle). Keep this file free of Deno-specific imports —
// drizzle-kit (Node-based) loads it directly when generating migrations.
import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
