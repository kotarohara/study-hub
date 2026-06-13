// Cloudflare Turnstile verification for public participant pages
// (spec §3.4). Like the other integrations, the non-production adapter is
// a local fake: no test or dev flow ever calls the network.
import type { Config } from "../config.ts";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Token the dev/test stub rejects, so failure paths are testable. */
export const STUB_FAIL_TOKEN = "turnstile-fail";

export async function verifyTurnstile(opts: {
  config: Config;
  /** The widget's cf-turnstile-response form field. */
  token: string;
  ip?: string;
}): Promise<boolean> {
  const { config, token } = opts;
  if (config.APP_ENV !== "production") {
    // Local stub: accept anything except the designated failure token.
    return token !== STUB_FAIL_TOKEN;
  }
  // Fail closed: an unconfigured production screener accepts nobody
  // rather than skipping bot protection silently.
  if (!config.TURNSTILE_SECRET_KEY || !token) return false;

  const body = new URLSearchParams({
    secret: config.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (opts.ip) body.set("remoteip", opts.ip);
  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const outcome = await res.json() as { success?: boolean };
    return outcome.success === true;
  } catch {
    return false;
  }
}
