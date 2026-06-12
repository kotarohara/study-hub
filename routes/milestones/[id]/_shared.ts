import type { Milestone } from "../../../lib/db/schema.ts";

/** Where a milestone "lives": its study's or project's timeline tab. */
export function milestoneHome(milestone: Milestone): string {
  return milestone.studyId
    ? `/studies/${milestone.studyId}?tab=timeline`
    : `/projects/${milestone.projectId}?tab=timeline`;
}
