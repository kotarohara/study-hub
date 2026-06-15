import { App, csrf, staticFiles } from "fresh";
import type { State } from "./utils.ts";
import { getConfig } from "./lib/config.ts";
import { registerBackupCron } from "./lib/jobs/backup_cron.ts";
import { registerMessageCron } from "./lib/jobs/message_cron.ts";
import { sessionMiddleware } from "./lib/auth/middleware.ts";
import { AUDIT_RULES, createAuditMiddleware } from "./lib/audit/middleware.ts";
import { registerAdapter } from "./lib/integrations/channel.ts";
import { EmailAdapter } from "./lib/integrations/email.ts";

registerBackupCron(getConfig());
registerMessageCron(getConfig());
// Outbound channels (spec §6). Email runs on both backends from one
// config (Mailpit in dev / SES in production); Telegram and Discord
// register in later phases.
registerAdapter(new EmailAdapter(getConfig()));

export const app = new App<State>();

app.use(staticFiles());

// Rejects state-changing cross-origin requests (Sec-Fetch-Site / Origin).
app.use(csrf());

app.use((ctx) => {
  ctx.state.requestId = crypto.randomUUID();
  return ctx.next();
});

app.use(sessionMiddleware);

app.use(createAuditMiddleware(AUDIT_RULES));

app.fsRoutes();
