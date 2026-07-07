// Notion one-way push (spec §5.5: "internal only, one-way push"). A
// "Push to Notion" action on a Study writes/updates ONE row in a lab
// Notion database: status, phase, milestone summary, and a link back to
// StudyHub — lab-wiki visibility, nothing more. Two-way sync is cut.
//
// INVARIANT (spec §5.5, CLAUDE.md): no PII to Notion, EVER. The snapshot
// type carries only study-level fields and aggregate counts — there is no
// field for a participant name, email, code list, or channel value. The
// no-PII test in notion_test.ts serializes every payload and asserts it.
import { getConfig } from "../config.ts";

/** Calls a Notion API endpoint; injectable so tests run without network. */
export type NotionTransport = (
  method: "POST" | "PATCH",
  path: string,
  payload: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; pageId?: string }>;

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export function fetchTransport(token: string): NotionTransport {
  return async (method, path, payload) => {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "notion-version": NOTION_VERSION,
      },
      body: JSON.stringify(payload),
    });
    let pageId: string | undefined;
    try {
      const body = await res.json() as { id?: string };
      pageId = body.id;
    } catch {
      // A non-JSON body means no page id; ok/status still tell the story.
    }
    return { ok: res.ok, status: res.status, pageId };
  };
}

/** Everything the Notion row shows — study-level, aggregate, PII-free by
 * construction. */
export interface StudySnapshot {
  name: string;
  status: string;
  methodology: string;
  oversight: string;
  /** Consented+ enrollments vs the target (aggregates, not people). */
  enrolled: number;
  targetN: number | null;
  /** "3/5 done · next: Pilot report (2026-08-01)" */
  milestoneSummary: string;
  /** Deep link back to the StudyHub study page. */
  studyHubUrl: string;
}

/** Notion page properties for a snapshot. Pure. Property names must match
 * the lab database's columns (documented in .env.example). */
export function formatStudyProperties(
  snapshot: StudySnapshot,
): Record<string, unknown> {
  return {
    Name: { title: [{ text: { content: snapshot.name } }] },
    Status: { select: { name: snapshot.status } },
    Methodology: { select: { name: snapshot.methodology } },
    Oversight: { select: { name: snapshot.oversight } },
    Enrolled: { number: snapshot.enrolled },
    Target: { number: snapshot.targetN },
    Milestones: {
      rich_text: [{ text: { content: snapshot.milestoneSummary } }],
    },
    StudyHub: { url: snapshot.studyHubUrl },
  };
}

export function notionConfigured(): boolean {
  const config = getConfig();
  return !!config.NOTION_API_TOKEN && !!config.NOTION_DATABASE_ID;
}

export interface PushResult {
  ok: boolean;
  /** The Notion page written; store it so the next push updates in place. */
  pageId?: string;
  error?: string;
}

/**
 * Creates the study's Notion row (first push) or updates it in place
 * (pageId from the previous push). Never throws — a wiki push must not
 * break the caller; failures come back as { ok: false }.
 */
export async function pushStudySnapshot(opts: {
  snapshot: StudySnapshot;
  /** Existing Notion page for this study, or "" to create one. */
  pageId: string;
  databaseId: string;
  transport: NotionTransport;
}): Promise<PushResult> {
  const properties = formatStudyProperties(opts.snapshot);
  try {
    const result = opts.pageId
      ? await opts.transport("PATCH", `/pages/${opts.pageId}`, { properties })
      : await opts.transport("POST", "/pages", {
        parent: { database_id: opts.databaseId },
        properties,
      });
    if (!result.ok) {
      return { ok: false, error: `Notion responded ${result.status}` };
    }
    return { ok: true, pageId: result.pageId ?? opts.pageId ?? undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "push failed",
    };
  }
}
