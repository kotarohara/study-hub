// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { pgTable, uuid } from "drizzle-orm/pg-core";
import { isEncrypted } from "../crypto/encryption.ts";
import { encryptedText } from "./encrypted.ts";
import { closeTestDb, getTestDb } from "./test_util.ts";

// Throwaway table: created/dropped by the test itself, not a migration.
const piiTest = pgTable("encrypted_column_test", {
  id: uuid("id").primaryKey().defaultRandom(),
  secret: encryptedText("secret").notNull(),
});

Deno.test("encryptedText: plaintext in app, ciphertext in the database", async (t) => {
  const db = await getTestDb();
  await db.execute(sql`
    create table if not exists encrypted_column_test (
      id uuid primary key default gen_random_uuid(),
      secret text not null
    )
  `);
  try {
    const plaintext = "alice@example.com / PayNow +65 9123 4567";
    const [row] = await db
      .insert(piiTest)
      .values({ secret: plaintext })
      .returning();
    assert.equal(row.secret, plaintext);

    const found = await db.select().from(piiTest);
    assert.equal(found[0].secret, plaintext);

    // What the database actually stores must be ciphertext.
    const raw = await db.execute<{ secret: string }>(
      sql`select secret from encrypted_column_test where id = ${row.id}`,
    );
    const stored = raw[0].secret;
    assert.ok(isEncrypted(stored), `expected ciphertext, got: ${stored}`);
    assert.ok(!stored.includes("alice"));
    assert.ok(!stored.includes("9123"));
  } finally {
    await db.execute(sql`drop table if exists encrypted_column_test`);
    await t.step("cleanup", closeTestDb);
  }
});
