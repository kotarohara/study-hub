// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import { backoffMs, MAX_ATTEMPTS } from "./message_runner.ts";

Deno.test("backoffMs: exponential from 1 minute, capped at 1 hour", () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(backoffMs(4), 480_000);
  // Caps at an hour rather than growing unbounded.
  assert.equal(backoffMs(20), 60 * 60_000);
  // Defensive: attempts ≤ 1 still yields the base, never < base.
  assert.equal(backoffMs(0), 60_000);
  assert.ok(MAX_ATTEMPTS >= 3);
});
