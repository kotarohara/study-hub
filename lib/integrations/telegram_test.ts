// Pure/unit tests — no network, no DB. The Bot API is exercised through an
// injected transport with simulated responses.
import assert from "node:assert/strict";
import {
  pairingDeepLink,
  TelegramAdapter,
  type TelegramResponse,
  type TelegramTransport,
  toSendResult,
} from "./telegram.ts";
import { parseUpdate } from "./telegram_update.ts";

// --- parseUpdate ---------------------------------------------------------

function message(text: string, chatId: number | string = 4242) {
  return { update_id: 1, message: { chat: { id: chatId }, text } };
}

Deno.test("parseUpdate: /start with a pairing token", () => {
  const cmd = parseUpdate(message("/start abc.def"));
  assert.deepEqual(cmd, { kind: "start", chatId: "4242", token: "abc.def" });
});

Deno.test("parseUpdate: bare /start has a null token", () => {
  assert.deepEqual(parseUpdate(message("/start")), {
    kind: "start",
    chatId: "4242",
    token: null,
  });
});

Deno.test("parseUpdate: bot-addressed command and extra whitespace", () => {
  const cmd = parseUpdate(message("  /start@StudyHubBot   tok123  "));
  assert.deepEqual(cmd, { kind: "start", chatId: "4242", token: "tok123" });
});

Deno.test("parseUpdate: /stop", () => {
  assert.deepEqual(parseUpdate(message("/stop")), {
    kind: "stop",
    chatId: "4242",
  });
  assert.deepEqual(parseUpdate(message("/stop@StudyHubBot")), {
    kind: "stop",
    chatId: "4242",
  });
});

Deno.test("parseUpdate: non-command text is 'other'", () => {
  assert.deepEqual(parseUpdate(message("hello there")), {
    kind: "other",
    chatId: "4242",
  });
});

Deno.test("parseUpdate: string chat id is preserved", () => {
  assert.deepEqual(parseUpdate(message("/stop", "9007199254740993")), {
    kind: "stop",
    chatId: "9007199254740993",
  });
});

Deno.test("parseUpdate: anything unrecognized is ignored", () => {
  assert.equal(parseUpdate(null).kind, "ignore");
  assert.equal(parseUpdate({}).kind, "ignore");
  assert.equal(parseUpdate({ edited_message: {} }).kind, "ignore");
  assert.equal(parseUpdate({ message: { chat: { id: 1 } } }).kind, "ignore"); // no text
  assert.equal(parseUpdate({ message: { text: "/stop" } }).kind, "ignore"); // no chat
  assert.equal(
    parseUpdate({ message: { chat: { id: 1 }, text: "  " } }).kind,
    "ignore",
  );
});

// --- toSendResult --------------------------------------------------------

Deno.test("toSendResult: success carries the message id", () => {
  const r = toSendResult({ ok: true, result: { message_id: 77 } });
  assert.deepEqual(r, { ok: true, providerMessageId: "77" });
});

Deno.test("toSendResult: success without a message id", () => {
  assert.deepEqual(toSendResult({ ok: true }), {
    ok: true,
    providerMessageId: undefined,
  });
});

Deno.test("toSendResult: failure surfaces code and description (no PII)", () => {
  const r = toSendResult({
    ok: false,
    error_code: 403,
    description: "Forbidden: bot was blocked by the user",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "403: Forbidden: bot was blocked by the user");
});

// --- pairingDeepLink -----------------------------------------------------

Deno.test("pairingDeepLink: builds a t.me start link, encoding the token", () => {
  assert.equal(
    pairingDeepLink("StudyHubBot", "a.b+c/d"),
    "https://t.me/StudyHubBot?start=a.b%2Bc%2Fd",
  );
});

// --- TelegramAdapter.send ------------------------------------------------

function transportReturning(response: TelegramResponse): {
  transport: TelegramTransport;
  calls: { method: string; payload: Record<string, unknown> }[];
} {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  return {
    calls,
    // deno-lint-ignore require-await
    transport: async (method, payload) => {
      calls.push({ method, payload });
      return response;
    },
  };
}

Deno.test("TelegramAdapter: sends chat_id + text and reports the message id", async () => {
  const { transport, calls } = transportReturning({
    ok: true,
    result: { message_id: 5 },
  });
  const adapter = new TelegramAdapter({ botToken: "T", transport });
  const result = await adapter.send({ to: "4242", body: "Hi Ada" });

  assert.deepEqual(result, { ok: true, providerMessageId: "5" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.deepEqual(calls[0].payload, { chat_id: "4242", text: "Hi Ada" });
});

Deno.test("TelegramAdapter: an API-level failure is a failed send", async () => {
  const { transport } = transportReturning({
    ok: false,
    error_code: 400,
    description: "chat not found",
  });
  const adapter = new TelegramAdapter({ botToken: "T", transport });
  const result = await adapter.send({ to: "0", body: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "400: chat not found");
});

Deno.test("TelegramAdapter: a transport error is caught (retryable)", async () => {
  const adapter = new TelegramAdapter({
    botToken: "T",
    transport: () => Promise.reject(new Error("network down")),
  });
  const result = await adapter.send({ to: "1", body: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "network down");
});
