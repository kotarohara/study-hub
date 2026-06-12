import { App, csrf, staticFiles } from "fresh";
import type { State } from "./utils.ts";
import { getConfig } from "./lib/config.ts";
import { registerBackupCron } from "./lib/jobs/backup_cron.ts";
import { sessionMiddleware } from "./lib/auth/middleware.ts";

registerBackupCron(getConfig());

export const app = new App<State>();

app.use(staticFiles());

// Rejects state-changing cross-origin requests (Sec-Fetch-Site / Origin).
app.use(csrf());

app.use((ctx) => {
  ctx.state.requestId = crypto.randomUUID();
  return ctx.next();
});

app.use(sessionMiddleware);

app.fsRoutes();
