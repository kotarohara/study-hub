// Role hierarchy (spec §3.10): PI > Researcher > Assistant > Collaborator.
import type { Member } from "../db/schema.ts";

export type Role = Member["role"];

const RANK: Record<Role, number> = {
  pi: 4,
  researcher: 3,
  assistant: 2,
  collaborator: 1,
};

/** True when `role` has at least the privileges of `required`. */
export function hasRole(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}
