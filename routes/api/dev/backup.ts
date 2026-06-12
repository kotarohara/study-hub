// Manual backup trigger for development (the nightly job runs via
// Deno.cron in production). Hidden outside development.
import { define } from "../../../utils.ts";
import { getConfig } from "../../../lib/config.ts";
import { runBackup } from "../../../lib/backup.ts";
import { createFileStores } from "../../../lib/storage/filestore.ts";

export const handler = define.handlers({
  async POST() {
    const config = getConfig();
    if (config.APP_ENV !== "development") {
      return new Response("Not Found", { status: 404 });
    }
    const { backups } = createFileStores(config);
    const result = await runBackup({
      databaseUrl: config.DATABASE_URL,
      store: backups,
    });
    return Response.json(result);
  },
});
