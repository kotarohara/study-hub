/// <reference lib="deno.unstable" />
import type { Config } from "../config.ts";
import { runBackup } from "../backup.ts";
import { createFileStores } from "../storage/filestore.ts";

/**
 * Registers the nightly pg_dump job (spec §7: backups are a requirement,
 * not an afterthought). Requires --unstable-cron; no-ops with a warning
 * when Deno.cron is unavailable so dev servers without the flag still run.
 * Failure alerts to Discord arrive with the messaging core (Phase 3.3).
 */
export function registerBackupCron(config: Config): boolean {
  if (!config.BACKUP_CRON_ENABLED) return false;
  if (typeof Deno.cron !== "function") {
    console.warn(
      "BACKUP_CRON_ENABLED is set but Deno.cron is unavailable — run with --unstable-cron",
    );
    return false;
  }
  Deno.cron("nightly pg_dump", config.BACKUP_CRON, async () => {
    try {
      const { backups } = createFileStores(config);
      const result = await runBackup({
        databaseUrl: config.DATABASE_URL,
        store: backups,
      });
      console.log(`backup ok: ${result.key} (${result.bytes} bytes)`);
    } catch (err) {
      console.error("backup FAILED:", err);
    }
  });
  return true;
}
