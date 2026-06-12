// Shared limiter instances for auth endpoints (per client IP).
import { RateLimiter } from "../rate_limit.ts";

/** 5 attempts, then 1 attempt per 12s. */
export const loginLimiter = new RateLimiter({
  capacity: 5,
  refillPerSecond: 5 / 60,
});

export const inviteAcceptLimiter = new RateLimiter({
  capacity: 5,
  refillPerSecond: 5 / 60,
});

/** Key for per-client buckets: the client IP. */
export function clientHost(info: Deno.ServeHandlerInfo): string {
  const addr = info.remoteAddr;
  return "hostname" in addr ? addr.hostname : "local";
}
