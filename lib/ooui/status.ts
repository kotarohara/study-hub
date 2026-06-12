// Lifecycle states render as status badges that gate available actions
// (spec §2.2 #5). Tones are semantic; StatusBadge maps them to classes.

export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "pilot";

export interface StatusView {
  label: string;
  tone: StatusTone;
}

/** Known lifecycle states and roles → tone. Extend as object types land. */
const TONES: Record<string, StatusTone> = {
  // Study lifecycle (spec §2.2)
  draft: "neutral",
  irb_review: "info",
  recruiting: "info",
  running: "success",
  analysis: "warning",
  archived: "neutral",
  pilot: "pilot",
  // Enrollment lifecycle
  screened: "neutral",
  eligible: "info",
  consented: "info",
  active: "success",
  completed: "success",
  withdrawn: "warning",
  excluded: "danger",
  // Milestones (spec §3.7) — "blocked" is derived, never stored
  pending: "neutral",
  in_progress: "info",
  done: "success",
  blocked: "danger",
  // Document review workflow (spec §3.3)
  internal_review: "info",
  submitted: "info",
  approved: "success",
  revisions_requested: "warning",
  // Oversight pathways (spec §3.3) — internal pilot is deliberately loud
  irb_reviewed: "info",
  irb_exempt: "warning",
  internal_pilot: "pilot",
  // Instruments (spec §4 kept-feature 4)
  simple_form: "info",
  external: "neutral",
  // Participants (spec §3.4) — do-not-contact is deliberately loud
  do_not_contact: "danger",
  preferred: "info",
  verified: "success",
  // Member roles
  pi: "info",
  researcher: "neutral",
  assistant: "neutral",
  collaborator: "neutral",
};

export function statusView(status: string): StatusView {
  return {
    label: status.replaceAll("_", " ").replace(/^irb/, "IRB"),
    tone: TONES[status] ?? "neutral",
  };
}
