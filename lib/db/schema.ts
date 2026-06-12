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
