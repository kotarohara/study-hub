// Integration tests — require the local stack (`deno task stack:up`) and
// the postgres client tools (pg_dump/pg_restore) on PATH.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config.ts";
import { latestBackupKey, runBackup, runRestore } from "./backup.ts";
import { createFileStores } from "./storage/filestore.ts";
import { fakeMember } from "./db/factories.ts";
import { members } from "./db/schema.ts";
import { closeTestDb, getTestDb } from "./db/test_util.ts";

const config = loadConfig();
const { backups } = createFileStores(config);

Deno.test("backup → data loss → restore brings the data back", async (t) => {
  const db = await getTestDb();
  const marker = fakeMember({
    email: `backup-marker-${crypto.randomUUID()}@studyhub.local`,
  });
  let key: string | undefined;

  try {
    // Committed on purpose: the row must be visible to pg_dump.
    await db.insert(members).values(marker);

    const result = await runBackup({
      databaseUrl: config.DATABASE_URL,
      store: backups,
    });
    key = result.key;
    assert.ok(result.bytes > 0);
    assert.ok(await backups.exists(key));
    assert.equal(await latestBackupKey(backups), key);

    // Simulate data loss.
    await db.delete(members).where(eq(members.email, marker.email));
    assert.equal(
      await db.query.members.findFirst({
        where: eq(members.email, marker.email),
      }),
      undefined,
    );

    // pg_restore --clean rebuilds objects, so drop pooled connections first.
    await closeTestDb();
    await runRestore({
      databaseUrl: config.DATABASE_URL,
      store: backups,
      key,
    });

    const restoredDb = await getTestDb();
    const restored = await restoredDb.query.members.findFirst({
      where: eq(members.email, marker.email),
    });
    assert.equal(restored?.name, marker.name);
  } finally {
    const cleanupDb = await getTestDb();
    await cleanupDb.delete(members).where(eq(members.email, marker.email));
    if (key) await backups.delete(key);
    await t.step("close", closeTestDb);
  }
});
