// Pure-logic tests — no stack, no network.
import assert from "node:assert/strict";
import { clearAdapters, getAdapter, registerAdapter } from "./channel.ts";
import { FakeAdapter } from "./fake_channel.ts";

Deno.test("FakeAdapter: records sends and can be told to fail", async () => {
  const adapter = new FakeAdapter("email");
  const ok = await adapter.send({
    to: "a@example.com",
    subject: "Hi",
    body: "Yo",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.providerMessageId, "fake-1");
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].to, "a@example.com");

  adapter.failWith = "smtp down";
  const bad = await adapter.send({ to: "b@example.com", body: "x" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "smtp down");
  // A failed send is not recorded as delivered.
  assert.equal(adapter.sent.length, 1);
});

Deno.test("registry: register, look up by channel, clear", () => {
  clearAdapters();
  assert.equal(getAdapter("email"), undefined);
  const email = new FakeAdapter("email");
  registerAdapter(email);
  assert.equal(getAdapter("email"), email);
  assert.equal(getAdapter("telegram"), undefined);
  clearAdapters();
  assert.equal(getAdapter("email"), undefined);
});
