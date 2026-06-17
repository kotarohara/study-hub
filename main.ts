import { App, csrf, staticFiles } from "fresh";
import type { State } from "./utils.ts";
import { getConfig } from "./lib/config.ts";
import { registerBackupCron } from "./lib/jobs/backup_cron.ts";
import { registerMessageCron } from "./lib/jobs/message_cron.ts";
import { sessionMiddleware } from "./lib/auth/middleware.ts";
import { AUDIT_RULES, createAuditMiddleware } from "./lib/audit/middleware.ts";
import { registerAdapter } from "./lib/integrations/channel.ts";
import { EmailAdapter } from "./lib/integrations/email.ts";
import { TelegramAdapter } from "./lib/integrations/telegram.ts";
import { discordAlertSink } from "./lib/integrations/discord.ts";
import { setAlertSink } from "./lib/jobs/alerts.ts";

registerBackupCron(getConfig());
registerMessageCron(getConfig());
// Outbound channels (spec §6). Email runs on both backends from one
// config (Mailpit in dev / SES in production). Telegram registers only when
// a bot token is configured — otherwise the lab runs on email alone and no
// telegram channel is ever paired.
registerAdapter(new EmailAdapter(getConfig()));
if (getConfig().TELEGRAM_BOT_TOKEN) {
  registerAdapter(
    new TelegramAdapter({ botToken: getConfig().TELEGRAM_BOT_TOKEN }),
  );
}
// Internal notifications (spec §5.4): route background-failure alerts to a
// Discord channel when a webhook is configured; otherwise they stay on the
// console. Pseudonymous content only.
if (getConfig().DISCORD_WEBHOOK_URL) {
  setAlertSink(
    discordAlertSink({ webhookUrl: getConfig().DISCORD_WEBHOOK_URL }),
  );
}

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
