import { HttpError } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../db/client.ts";
import { RateLimiter, type RateLimiterOptions } from "../rate_limit.ts";
import type { Role } from "./roles.ts";
import { hasRole } from "./roles.ts";
import { getSessionMember, readSessionCookie } from "./session.ts";

/** Resolves the session cookie to ctx.state.member (or null). Global. */
export const sessionMiddleware = define.middleware(async (ctx) => {
  ctx.state.member = null;
  const token = readSessionCookie(ctx.req);
  if (token) {
    ctx.state.member = await getSessionMember(getDb(), token);
  }
  return await ctx.next();
});

/**
 * Gate for lab-member pages/APIs. Redirects anonymous browsers to /login,
 * 401s API clients, and 403s members below `minRole`.
 */
export function requireMember(minRole: Role = "collaborator") {
  return define.middleware((ctx) => {
    const member = ctx.state.member;
    if (!member) {
      const accepts = ctx.req.headers.get("accept") ?? "";
      if (accepts.includes("text/html")) {
        const next = encodeURIComponent(
          ctx.url.pathname + ctx.url.search,
        );
        return ctx.redirect(`/login?next=${next}`);
      }
      throw new HttpError(401);
    }
    if (!hasRole(member.role, minRole)) {
      throw new HttpError(403);
    }
    return ctx.next();
  });
}

/** Per-client-IP token-bucket limiter; 429 when exhausted. */
export function rateLimit(opts: RateLimiterOptions & { name: string }) {
  const limiter = new RateLimiter(opts);
  let requests = 0;
  return define.middleware((ctx) => {
    const addr = ctx.info.remoteAddr;
    const host = addr.transport === "tcp" ? addr.hostname : "local";
    if (!limiter.check(`${opts.name}:${host}`)) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    if (++requests % 1000 === 0) limiter.prune();
    return ctx.next();
  });
}
