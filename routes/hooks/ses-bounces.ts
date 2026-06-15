// SES → SNS bounce/complaint webhook (spec §3.8). Public (SNS posts
// unauthenticated) but guarded by a shared ?token= when SES_WEBHOOK_TOKEN
// is configured. A permanent bounce or a complaint suppresses the matching
// email channel(s) so we stop sending to a dead or hostile address. Always
// replies 200 to non-auth errors so SNS does not retry a malformed notice.
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { getConfig } from "../../lib/config.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import {
  parseSnsMessage,
  SnsParseError,
} from "../../lib/integrations/ses_bounce.ts";
import { suppressEmailChannels } from "../../lib/objects/participants.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const config = getConfig();
    if (config.SES_WEBHOOK_TOKEN) {
      const token = ctx.url.searchParams.get("token") ?? "";
      if (token !== config.SES_WEBHOOK_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    let parsed;
    try {
      parsed = parseSnsMessage(await ctx.req.text());
    } catch (err) {
      if (err instanceof SnsParseError) {
        return new Response("bad request", { status: 400 });
      }
      throw err;
    }

    if (parsed.type === "subscription_confirmation") {
      // Confirm the SNS subscription in production by visiting SubscribeURL.
      if (config.APP_ENV === "production" && parsed.subscribeUrl) {
        try {
          await fetch(parsed.subscribeUrl);
        } catch {
          // Surfaced via SNS retries; nothing actionable here.
        }
      }
      return new Response("ok");
    }

    if (parsed.type === "notification") {
      const auditCtx = {
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      };
      const db = getDb();
      if (parsed.bounced.length > 0) {
        await suppressEmailChannels(db, parsed.bounced, {
          reason: "bounce",
          ...auditCtx,
        });
      }
      if (parsed.complained.length > 0) {
        await suppressEmailChannels(db, parsed.complained, {
          reason: "complaint",
          ...auditCtx,
        });
      }
    }
    return new Response("ok");
  },
});
