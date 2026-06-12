// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import { members } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { authenticate } from "./login.ts";
import { hashPassword } from "./password.ts";

Deno.test("authenticate: correct, wrong, unknown, and passwordless", async () => {
  const db = await getTestDb();
  const email = `login-${crypto.randomUUID()}@studyhub.local`;
  const noPwEmail = `nopw-${crypto.randomUUID()}@studyhub.local`;
  await db.insert(members).values([
    fakeMember({ email, passwordHash: await hashPassword("right-password") }),
    fakeMember({ email: noPwEmail }), // invite not yet accepted
  ]);
  try {
    const ok = await authenticate(
      db,
      ` ${email.toUpperCase()} `,
      "right-password",
    );
    assert.equal(ok?.email, email);

    assert.equal(await authenticate(db, email, "wrong-password"), null);
    assert.equal(await authenticate(db, "nobody@studyhub.local", "x"), null);
    assert.equal(await authenticate(db, noPwEmail, "anything"), null);
  } finally {
    await db.delete(members).where(eq(members.email, email));
    await db.delete(members).where(eq(members.email, noPwEmail));
    await closeTestDb();
  }
});
