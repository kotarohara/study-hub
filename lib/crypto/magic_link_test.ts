import assert from "node:assert/strict";
import { signToken, TokenError, verifyToken } from "./magic_link.ts";

const SECRET = "test-secret-at-least-32-characters-long!";
const now = new Date("2026-06-12T00:00:00Z");

function reason(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected TokenError");
  } catch (err) {
    if (err instanceof TokenError) return err.reason;
    throw err;
  }
}

Deno.test("sign/verify roundtrip", () => {
  const token = signToken(SECRET, {
    purpose: "consent",
    subject: "enrollment-123",
    ttlSeconds: 3600,
    now,
  });
  const verified = verifyToken(SECRET, token, { purpose: "consent", now });
  assert.equal(verified.subject, "enrollment-123");
  assert.equal(
    verified.expiresAt.getTime(),
    now.getTime() + 3600 * 1000,
  );
});

Deno.test("expired tokens are rejected", () => {
  const token = signToken(SECRET, {
    purpose: "diary",
    subject: "x",
    ttlSeconds: 60,
    now,
  });
  const later = new Date(now.getTime() + 61 * 1000);
  assert.equal(
    reason(() => verifyToken(SECRET, token, { purpose: "diary", now: later })),
    "expired",
  );
  // Boundary: valid one second before expiry.
  const justBefore = new Date(now.getTime() + 59 * 1000);
  verifyToken(SECRET, token, { purpose: "diary", now: justBefore });
});

Deno.test("purpose scoping: a consent link is not a booking link", () => {
  const token = signToken(SECRET, {
    purpose: "consent",
    subject: "x",
    ttlSeconds: 3600,
    now,
  });
  assert.equal(
    reason(() => verifyToken(SECRET, token, { purpose: "booking", now })),
    "wrong_purpose",
  );
});

Deno.test("tampered payload or signature is rejected", () => {
  const token = signToken(SECRET, {
    purpose: "screener",
    subject: "abc",
    ttlSeconds: 3600,
    now,
  });
  const [body, sig] = token.split(".");

  // Forged payload with the old signature.
  const forgedBody = body.slice(0, -2) + (body.endsWith("AA") ? "BB" : "AA");
  assert.equal(
    reason(() =>
      verifyToken(SECRET, `${forgedBody}.${sig}`, { purpose: "screener", now })
    ),
    "bad_signature",
  );

  // Valid payload with a truncated signature.
  assert.equal(
    reason(() =>
      verifyToken(SECRET, `${body}.${sig.slice(0, -4)}`, {
        purpose: "screener",
        now,
      })
    ),
    "bad_signature",
  );
});

Deno.test("wrong secret is rejected", () => {
  const token = signToken(SECRET, {
    purpose: "p",
    subject: "s",
    ttlSeconds: 60,
    now,
  });
  assert.equal(
    reason(() =>
      verifyToken("a-completely-different-32-char-secret!!", token, {
        purpose: "p",
        now,
      })
    ),
    "bad_signature",
  );
});

Deno.test("malformed tokens are rejected", () => {
  for (const bad of ["", "nodot", ".sigonly", "bodyonly.", "a.b.c…"]) {
    const r = reason(() => verifyToken(SECRET, bad, { purpose: "p", now }));
    assert.ok(r === "malformed" || r === "bad_signature", `${bad} → ${r}`);
  }
});
