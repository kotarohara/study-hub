// Manual restore: `deno task db:restore [key] [--yes]`
// Restores the given backup key, or the latest backup when omitted.
// DESTRUCTIVE: drops and recreates the database contents.
import { getConfig } from "../lib/config.ts";
import { latestBackupKey, runRestore } from "../lib/backup.ts";
import { createFileStores } from "../lib/storage/filestore.ts";

const config = getConfig();
const { backups } = createFileStores(config);

const args = Deno.args.filter((a) => a !== "--yes");
const skipConfirm = Deno.args.includes("--yes");

const key = args[0] ?? (await latestBackupKey(backups));
if (!key) {
  console.error("no backups found");
  Deno.exit(1);
}

if (!skipConfirm) {
  const ok = confirm(
    `Restore ${key} into ${config.APP_ENV} database? This OVERWRITES current data.`,
  );
  if (!ok) {
    console.log("aborted");
    Deno.exit(1);
  }
}

await runRestore({ databaseUrl: config.DATABASE_URL, store: backups, key });
console.log(`restored from ${key}`);
