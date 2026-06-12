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
