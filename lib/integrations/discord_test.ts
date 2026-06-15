// Pure/unit tests — no network, no DB. Webhook POSTs go through an injected
// transport. The headline test enforces the spec §5.4 invariant: no PII ever
// reaches Discord.
import assert from "node:assert/strict";
import {
  discordAlertSink,
  type DiscordEvent,
  type DiscordPayload,
  type DiscordTransport,
  formatAlert,
  formatEvent,
  postDiscord,
} from "./discord.ts";

function recorder(result = { ok: true, status: 204 }) {
  const calls: { url: string; payload: DiscordPayload }[] = [];
  const transport: DiscordTransport = (url, payload) => {
    calls.push({ url, payload });
    return Promise.resolve(result);
  };
  return { calls, transport };
}

// One representative event of every kind, all built from pseudonymous data.
const AT = new Date("2026-07-01T14:00:00.000Z");
const EVENTS: DiscordEvent[] = [
  { kind: "enrollment_eligible", study: "Sleep Study", code: "P-001" },
  { kind: "session_booked", study: "Sleep Study", code: "P-001", at: AT },
  { kind: "session_cancelled", study: "Sleep Study", code: "P-001", at: AT },
  { kind: "session_no_show", study: "Sleep Study", code: "P-001", at: AT },
  {
    kind: "milestone_due",
    study: "Sleep Study",
    title: "IRB renewal",
    due: "2026-07-10",
  },
  { kind: "irb_expiring", study: "Sleep Study", on: "2026-08-01" },
  {
    kind: "payment_pending",
    study: "Sleep Study",
    code: "P-001",
    amount: "SGD 20",
  },
];

Deno.test("no PII ever appears in a Discord payload (spec §5.4)", () => {
  // PII that would exist on the underlying Participant but must NEVER be sent.
  const PII = ["Ada Lovelace", "ada@example.com", "+6591234567", "@ada_tg"];
  for (const event of EVENTS) {
    const json = JSON.stringify(formatEvent(event));
    for (const leak of PII) {
      assert.ok(!json.includes(leak), `${event.kind} leaked PII: ${leak}`);
    }
    // The study name is internal (not PII) and always present.
    assert.ok(json.includes("Sleep Study"));
    // Participant-scoped events carry the pseudonymous code, nothing more.
    if ("code" in event) assert.ok(json.includes("P-001"));
  }
});

Deno.test("formatEvent: readable, kind-specific content", () => {
  assert.match(
    formatEvent(EVENTS[0]).content,
    /Sleep Study.*P-001.*eligible/,
  );
  assert.match(formatEvent(EVENTS[1]).content, /booked.*2026-07-01 14:00 UTC/);
  assert.match(formatEvent(EVENTS[6]).content, /SGD 20.*P-001|P-001.*SGD 20/);
});

Deno.test("formatAlert: renders kind + detail", () => {
  const payload = formatAlert({
    kind: "job.failed",
    detail: "backup timed out",
  });
  assert.match(payload.content, /job\.failed/);
  assert.match(payload.content, /backup timed out/);
});

Deno.test("postDiscord: delivers, reports non-2xx, swallows transport errors", async () => {
  const ok = recorder({ ok: true, status: 204 });
  assert.equal(
    await postDiscord("https://hook", { content: "hi" }, ok.transport),
    true,
  );
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, "https://hook");
  assert.equal(ok.calls[0].payload.content, "hi");

  const bad = recorder({ ok: false, status: 429 });
  assert.equal(
    await postDiscord("https://hook", { content: "x" }, bad.transport),
    false,
  );

  const boom: DiscordTransport = () => Promise.reject(new Error("network"));
  assert.equal(
    await postDiscord("https://hook", { content: "x" }, boom),
    false,
  );
});

Deno.test("discordAlertSink: posts a formatted alert to the webhook", async () => {
  const { calls, transport } = recorder();
  const sink = discordAlertSink({ webhookUrl: "https://hook", transport });
  await sink.notify({ kind: "message.delivery_failed", detail: "smtp down" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.content, /message\.delivery_failed/);
  assert.match(calls[0].payload.content, /smtp down/);
});
