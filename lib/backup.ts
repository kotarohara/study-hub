// Database backup/restore (spec §6, §7: nightly pg_dump to a versioned
// bucket is a Phase 0 deliverable). Uses the postgres client tools, which
// must be on PATH (the dev stack's Postgres is reachable over TCP, so no
// docker exec is needed).
import type { FileStore } from "./storage/filestore.ts";

export const BACKUP_PREFIX = "pg_dump/";

export interface BackupResult {
  key: string;
  bytes: number;
}

function backupKey(now: Date): string {
  const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
  return `${BACKUP_PREFIX}studyhub-${stamp}.dump`;
}

function describeFailure(cmd: string, out: Deno.CommandOutput): string {
  const stderr = new TextDecoder().decode(out.stderr).trim();
  return `${cmd} exited with code ${out.code}: ${stderr}`;
}

/** Dumps the database (pg_dump custom format) and uploads it to `store`. */
export async function runBackup(opts: {
  databaseUrl: string;
  store: FileStore;
  pgDumpPath?: string;
  now?: Date;
}): Promise<BackupResult> {
  const out = await new Deno.Command(opts.pgDumpPath ?? "pg_dump", {
    args: ["--format=custom", "--no-owner", "--dbname", opts.databaseUrl],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(describeFailure("pg_dump", out));
  }

  const key = backupKey(opts.now ?? new Date());
  await opts.store.put(key, out.stdout, {
    contentType: "application/octet-stream",
  });
  return { key, bytes: out.stdout.length };
}

/** Most recent backup key in `store`, or undefined if none exist. */
export async function latestBackupKey(
  store: FileStore,
): Promise<string | undefined> {
  const keys = await store.list(BACKUP_PREFIX);
  return keys.at(-1);
}

/** Downloads `key` from `store` and restores it with pg_restore --clean. */
export async function runRestore(opts: {
  databaseUrl: string;
  store: FileStore;
  key: string;
  pgRestorePath?: string;
}): Promise<void> {
  const dump = await opts.store.get(opts.key);

  const child = new Deno.Command(opts.pgRestorePath ?? "pg_restore", {
    args: [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--single-transaction",
      "--dbname",
      opts.databaseUrl,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(dump);
  await writer.close();

  const out = await child.output();
  if (out.code !== 0) {
    throw new Error(describeFailure("pg_restore", out));
  }
}
