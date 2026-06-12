// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { fakeMember } from "./factories.ts";
import { members } from "./schema.ts";
import { closeTestDb, getTestDb, withRollback } from "./test_util.ts";

Deno.test("members: insert and select roundtrip", async (t) => {
  await withRollback(async (tx) => {
    const input = fakeMember({ role: "pi" });
    const [inserted] = await tx.insert(members).values(input).returning();

    assert.ok(inserted.id);
    assert.equal(inserted.email, input.email);
    assert.equal(inserted.role, "pi");
    assert.equal(inserted.passwordHash, null);
    assert.ok(inserted.createdAt instanceof Date);

    const found = await tx.query.members.findFirst({
      where: eq(members.email, input.email),
    });
    assert.equal(found?.id, inserted.id);
  });
  await t.step("cleanup", closeTestDb);
});

/** Messages of `err` and every error in its cause chain (drizzle wraps the
 * postgres error, so the constraint detail lives on `cause`). */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(" | ");
}

Deno.test("members: email uniqueness is enforced", async (t) => {
  await withRollback(async (tx) => {
    const input = fakeMember();
    await tx.insert(members).values(input);
    await assert.rejects(
      () => tx.insert(members).values(fakeMember({ email: input.email })),
      (err: unknown) => {
        assert.match(
          errorChainText(err),
          /duplicate key|members_email_unique/,
        );
        return true;
      },
    );
  });
  await t.step("cleanup", closeTestDb);
});

Deno.test("withRollback leaves no rows behind", async (t) => {
  const input = fakeMember();
  await withRollback(async (tx) => {
    await tx.insert(members).values(input);
  });
  const db = await getTestDb();
  const found = await db.query.members.findFirst({
    where: eq(members.email, input.email),
  });
  assert.equal(found, undefined);
  await t.step("cleanup", closeTestDb);
});
