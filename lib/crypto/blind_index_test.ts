// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  blindIndex,
  channelIndex,
  normalizeChannelValue,
} from "./blind_index.ts";

const SECRET = "test-index-secret-at-least-32-chars!!";

Deno.test("normalization collapses trivially-different spellings", () => {
  assert.equal(
    normalizeChannelValue("email", "  Alice@Example.COM "),
    "alice@example.com",
  );
  assert.equal(
    normalizeChannelValue("phone", " +65 9123-4567 "),
    "+6591234567",
  );
  assert.equal(normalizeChannelValue("prolific", " AB12 "), "AB12");
});

Deno.test("index is deterministic and keyed", () => {
  const a = channelIndex(SECRET, "email", "Alice@Example.com");
  const b = channelIndex(SECRET, "email", "  alice@example.com ");
  assert.equal(a, b);
  assert.notEqual(a, channelIndex(SECRET, "email", "bob@example.com"));
  // Different kinds never collide, even with identical values.
  assert.notEqual(a, channelIndex(SECRET, "paypal", "alice@example.com"));
  // Different secrets produce unrelated indexes.
  assert.notEqual(
    a,
    channelIndex(
      "another-secret-with-32-characters!!!",
      "email",
      "alice@example.com",
    ),
  );
});

Deno.test("index output is opaque (no plaintext leakage)", () => {
  const idx = blindIndex(SECRET, "alice@example.com");
  assert.ok(!idx.includes("alice"));
  assert.ok(idx.length >= 40); // base64url SHA-256
});
