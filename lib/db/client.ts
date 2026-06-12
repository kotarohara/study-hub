import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getConfig } from "../config.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(databaseUrl: string, options: { max?: number } = {}) {
  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let singleton: ReturnType<typeof createDb> | undefined;

/** Process-wide database handle, connected from config on first use. */
export function getDb(): Db {
  singleton ??= createDb(getConfig().DATABASE_URL);
  return singleton.db;
}

export async function closeDb(): Promise<void> {
  await singleton?.sql.end({ timeout: 5 });
  singleton = undefined;
}
