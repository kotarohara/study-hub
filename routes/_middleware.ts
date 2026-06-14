// Global auth gate: everything is member-only except the public surface
// (login, invite acceptance, participant magic-link pages, health).
import { define } from "../utils.ts";
import { requireMember } from "../lib/auth/middleware.ts";

const PUBLIC_PATHS = [
  /^\/login$/,
  /^\/logout$/,
  /^\/invite\//,
  /^\/health$/,
  /^\/api\/dev\//, // dev-only routes guard themselves by APP_ENV
  /^\/p\//, // participant magic-link pages (Phase 2+)
  /^\/hooks\//, // inbound provider webhooks (SES bounces); token-guarded
];

const gate = requireMember("collaborator");

export default define.middleware((ctx) => {
  if (PUBLIC_PATHS.some((re) => re.test(ctx.url.pathname))) {
    return ctx.next();
  }
  return gate(ctx);
});
