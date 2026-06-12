// Test helpers — integration tests require the local stack (`deno task stack:up`).
import { TransactionRollbackError } from "drizzle-orm";
import { loadConfig } from "../config.ts";
import { createDb, type Db } from "./client.ts";
import { migrateDb } from "./migrate.ts";

const config = loadConfig();

let handle: ReturnType<typeof createDb> | undefined;
let migrated = false;

/** Migrated database handle for tests, created on first use. */
export async function getTestDb(): Promise<Db> {
  if (!migrated) {
    await migrateDb(config.DATABASE_URL);
    migrated = true;
  }
  handle ??= createDb(config.DATABASE_URL, { max: 3 });
  return handle.db;
}

export async function closeTestDb(): Promise<void> {
  await handle?.sql.end({ timeout: 5 });
  handle = undefined;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction that is always rolled back, so tests leave
 * no rows behind regardless of outcome.
 */
export async function withRollback(
  fn: (tx: Tx) => Promise<void>,
): Promise<void> {
  const db = await getTestDb();
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
}
