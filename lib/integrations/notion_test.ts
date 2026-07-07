// Pure tests — no network. The Notion API is exercised through an injected
// transport with simulated responses. The headline test enforces the spec
// §5.5 invariant: no PII ever reaches Notion.
import assert from "node:assert/strict";
import {
  formatStudyProperties,
  type NotionTransport,
  pushStudySnapshot,
  type StudySnapshot,
} from "./notion.ts";
import { milestoneSummary } from "../objects/notion_push.ts";
import type { MilestoneWithMeta } from "../objects/milestones.ts";
import type { Milestone } from "../db/schema.ts";

const SNAPSHOT: StudySnapshot = {
  name: "Sleep Study",
  status: "running",
  methodology: "diary_study",
  oversight: "irb_reviewed",
  enrolled: 12,
  targetN: 30,
  milestoneSummary: "2/5 done · next: Pilot report (2026-08-01)",
  studyHubUrl: "http://localhost:8000/studies/abc",
};

function recorder(result = { ok: true, status: 200, pageId: "page-1" }) {
  const calls: {
    method: string;
    path: string;
    payload: Record<string, unknown>;
  }[] = [];
  const transport: NotionTransport = (method, path, payload) => {
    calls.push({ method, path, payload });
    return Promise.resolve(result);
  };
  return { calls, transport };
}

Deno.test("no PII ever appears in a Notion payload (spec §5.5)", () => {
  // PII that exists in the system but must never reach Notion. The
  // snapshot type has no field for any of it — this guards regressions.
  const PII = ["Ada Lovelace", "ada@example.com", "+6591234567", "P-001"];
  const json = JSON.stringify(formatStudyProperties(SNAPSHOT));
  for (const leak of PII) {
    assert.ok(!json.includes(leak), `payload leaked "${leak}"`);
  }
  // What SHOULD be there: study-level fields and aggregates.
  assert.ok(json.includes("Sleep Study"));
  assert.ok(json.includes("running"));
  assert.ok(json.includes("/studies/abc"));
});

Deno.test("formatStudyProperties: Notion property shapes", () => {
  const props = formatStudyProperties(SNAPSHOT) as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(props.Name, {
    title: [{ text: { content: "Sleep Study" } }],
  });
  assert.deepEqual(props.Status, { select: { name: "running" } });
  assert.deepEqual(props.Enrolled, { number: 12 });
  assert.deepEqual(props.Target, { number: 30 });
  assert.deepEqual(props.StudyHub, {
    url: "http://localhost:8000/studies/abc",
  });
});

Deno.test("pushStudySnapshot: creates on first push, updates in place after", async () => {
  const first = recorder();
  const created = await pushStudySnapshot({
    snapshot: SNAPSHOT,
    pageId: "",
    databaseId: "db-9",
    transport: first.transport,
  });
  assert.equal(created.ok, true);
  assert.equal(created.pageId, "page-1");
  assert.equal(first.calls[0].method, "POST");
  assert.equal(first.calls[0].path, "/pages");
  assert.deepEqual(first.calls[0].payload.parent, { database_id: "db-9" });

  const second = recorder({ ok: true, status: 200, pageId: "page-1" });
  const updated = await pushStudySnapshot({
    snapshot: SNAPSHOT,
    pageId: "page-1",
    databaseId: "db-9",
    transport: second.transport,
  });
  assert.equal(updated.ok, true);
  assert.equal(second.calls[0].method, "PATCH");
  assert.equal(second.calls[0].path, "/pages/page-1");
  assert.ok(!("parent" in second.calls[0].payload));
});

Deno.test("pushStudySnapshot: API failure and transport error come back as ok:false", async () => {
  const bad = recorder({ ok: false, status: 400, pageId: undefined as never });
  const result = await pushStudySnapshot({
    snapshot: SNAPSHOT,
    pageId: "",
    databaseId: "db",
    transport: bad.transport,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /400/);

  const boom: NotionTransport = () => Promise.reject(new Error("offline"));
  const crashed = await pushStudySnapshot({
    snapshot: SNAPSHOT,
    pageId: "",
    databaseId: "db",
    transport: boom,
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.error, "offline");
});

function milestone(
  status: Milestone["status"],
  title: string,
  dueOn: string | null,
): MilestoneWithMeta {
  return {
    milestone: {
      status,
      title,
      dueOn: dueOn ? new Date(dueOn) : null,
    } as Milestone,
    owner: null,
    dependsOn: [],
    blocked: false,
  };
}

Deno.test("milestoneSummary: done count + next due", () => {
  assert.equal(milestoneSummary([]), "no milestones");
  assert.equal(
    milestoneSummary([
      milestone("done", "Ethics", "2026-01-01"),
      milestone("pending", "Pilot report", "2026-08-01"),
      milestone("in_progress", "Recruit", "2026-07-15"),
    ]),
    "1/3 done · next: Recruit (2026-07-15)",
  );
  assert.equal(
    milestoneSummary([milestone("pending", "Undated", null)]),
    "0/1 done",
  );
});
