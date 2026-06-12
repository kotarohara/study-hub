// Manual backup: `deno task db:backup`
import { getConfig } from "../lib/config.ts";
import { runBackup } from "../lib/backup.ts";
import { createFileStores } from "../lib/storage/filestore.ts";

const config = getConfig();
const { backups } = createFileStores(config);
const result = await runBackup({
  databaseUrl: config.DATABASE_URL,
  store: backups,
});
console.log(`backup written: ${result.key} (${result.bytes} bytes)`);
