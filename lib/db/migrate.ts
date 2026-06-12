import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getConfig } from "../config.ts";

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/** Applies all pending migrations from ./drizzle. Idempotent. */
export async function migrateDb(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await migrateDb(getConfig().DATABASE_URL);
  console.log("migrations applied");
}
