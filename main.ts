import { App, staticFiles } from "fresh";
import type { State } from "./utils.ts";
import { getConfig } from "./lib/config.ts";
import { registerBackupCron } from "./lib/jobs/backup_cron.ts";

registerBackupCron(getConfig());

export const app = new App<State>();

app.use(staticFiles());

app.use((ctx) => {
  ctx.state.requestId = crypto.randomUUID();
  return ctx.next();
});

app.fsRoutes();
