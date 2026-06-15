// Telegram Bot API webhook (spec §3.7). Telegram POSTs each update here.
// Guarded by a shared secret (set on setWebhook, echoed in the
// X-Telegram-Bot-Api-Secret-Token header) when TELEGRAM_WEBHOOK_SECRET is
// configured. All the logic lives in handleTelegramUpdate so it is testable
// with simulated payloads; this shell just authenticates, dispatches, and
// sends the reply. Always answers 200 so Telegram does not retry a handled
// (or unparseable) update.
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { getConfig } from "../../lib/config.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { getAdapter } from "../../lib/integrations/channel.ts";
import { handleTelegramUpdate } from "../../lib/objects/telegram.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const config = getConfig();
    if (config.TELEGRAM_WEBHOOK_SECRET) {
      const got = ctx.req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (got !== config.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    let raw: unknown;
    try {
      raw = await ctx.req.json();
    } catch {
      // A non-JSON body is nothing we can act on; ack so Telegram stops.
      return new Response("ok");
    }

    const { chatId, reply } = await handleTelegramUpdate(getDb(), raw, {
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    if (chatId && reply) {
      const adapter = getAdapter("telegram");
      if (adapter) await adapter.send({ to: chatId, body: reply });
    }
    return new Response("ok");
  },
});
