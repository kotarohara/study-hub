import assert from "node:assert/strict";
import { hashPassword, validatePassword, verifyPassword } from "./password.ts";

Deno.test("hash/verify roundtrip", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.ok(hash.startsWith("$argon2id$"));
  assert.equal(
    await verifyPassword(hash, "correct horse battery staple"),
    true,
  );
  assert.equal(await verifyPassword(hash, "wrong password"), false);
});

Deno.test("same password hashes differently (random salt)", async () => {
  const [a, b] = await Promise.all([hashPassword("pw"), hashPassword("pw")]);
  assert.notEqual(a, b);
});

Deno.test("malformed hash verifies false, not throws", async () => {
  assert.equal(await verifyPassword("not-a-hash", "pw"), false);
  assert.equal(await verifyPassword("", "pw"), false);
});

Deno.test("password policy", () => {
  assert.ok(validatePassword("short"));
  assert.equal(validatePassword("long enough password"), null);
});
