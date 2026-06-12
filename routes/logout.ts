import { define } from "../utils.ts";
import { getConfig } from "../lib/config.ts";
import { getDb } from "../lib/db/client.ts";
import {
  clearSessionCookie,
  destroySession,
  readSessionCookie,
} from "../lib/auth/session.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const token = readSessionCookie(ctx.req);
    if (token) await destroySession(getDb(), token);
    return new Response(null, {
      status: 303,
      headers: {
        location: "/login",
        "set-cookie": clearSessionCookie({
          secure: getConfig().APP_ENV === "production",
        }),
      },
    });
  },
});
