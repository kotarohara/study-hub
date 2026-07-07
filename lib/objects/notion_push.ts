// "Push to Notion" study action (spec §5.5): assembles the PII-free
// snapshot from live data, pushes it, and remembers the Notion page so
// later pushes update the same row. Audited — an internal export of study
// metadata, not PII, but a record of what left the system.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Member, studies, type Study } from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { getConfig } from "../config.ts";
import {
  fetchTransport,
  type NotionTransport,
  type PushResult,
  pushStudySnapshot,
  type StudySnapshot,
} from "../integrations/notion.ts";
import { studyFunnel } from "./funnel.ts";
import { listMilestonesOfStudy, type MilestoneWithMeta } from "./milestones.ts";
import type { AuditCtx } from "./studies.ts";

/** "3/5 done · next: Pilot report (2026-08-01)". Pure. */
export function milestoneSummary(rows: MilestoneWithMeta[]): string {
  if (rows.length === 0) return "no milestones";
  const done = rows.filter((r) => r.milestone.status === "done").length;
  const upcoming = rows
    .filter((r) => r.milestone.status !== "done" && r.milestone.dueOn)
    .sort((a, b) =>
      a.milestone.dueOn!.getTime() - b.milestone.dueOn!.getTime()
    )[0];
  const next = upcoming
    ? ` · next: ${upcoming.milestone.title} (${
      upcoming.milestone.dueOn!.toISOString().slice(0, 10)
    })`
    : "";
  return `${done}/${rows.length} done${next}`;
}

export async function buildStudySnapshot(
  db: Db,
  study: Study,
): Promise<StudySnapshot> {
  const funnel = await studyFunnel(db, study);
  const milestones = await listMilestonesOfStudy(db, study.id);
  return {
    name: study.name,
    status: study.status,
    methodology: study.methodology,
    oversight: study.oversightPathway,
    enrolled: funnel.overall.count,
    targetN: funnel.overall.target,
    milestoneSummary: milestoneSummary(milestones),
    studyHubUrl: `${getConfig().APP_URL}/studies/${study.id}`,
  };
}

/** Pushes the study's row to the lab Notion database, creating it on the
 * first push and updating it afterwards. Audited. */
export async function pushStudyToNotion(
  db: Db,
  opts: {
    study: Study;
    actor: Member;
    /** Test hook; production uses the real API transport. */
    transport?: NotionTransport;
  } & AuditCtx,
): Promise<PushResult> {
  const config = getConfig();
  if (!config.NOTION_API_TOKEN || !config.NOTION_DATABASE_ID) {
    return { ok: false, error: "Notion is not configured." };
  }
  const snapshot = await buildStudySnapshot(db, opts.study);
  const result = await pushStudySnapshot({
    snapshot,
    pageId: opts.study.notionPageId,
    databaseId: config.NOTION_DATABASE_ID,
    transport: opts.transport ?? fetchTransport(config.NOTION_API_TOKEN),
  });

  if (result.ok && result.pageId && result.pageId !== opts.study.notionPageId) {
    await db
      .update(studies)
      .set({ notionPageId: result.pageId, updatedAt: new Date() })
      .where(eq(studies.id, opts.study.id));
  }
  await audit(db, {
    action: "study.notion_pushed",
    actorId: opts.actor.id,
    objectType: "study",
    objectId: opts.study.id,
    details: { ok: result.ok, updated: !!opts.study.notionPageId },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return result;
}
