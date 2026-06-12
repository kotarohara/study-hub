// Route-pattern audit middleware (spec §4: audit "via middleware"). Logs
// after a matched request succeeds (2xx/3xx); the actor comes from the
// session state resolved earlier in the chain.
//
// Recording happens after the response is computed: for a *view* the data
// has already been seen, so failing the response would not un-see it — the
// failure is logged loudly instead. Actions where an unrecorded success is
// unacceptable (exports, deletions, payment approvals) must call audit()
// directly in their handler BEFORE returning.
import { define } from "../../utils.ts";
import { getDb } from "../db/client.ts";
import { clientHost } from "../auth/limiters.ts";
import { audit } from "./log.ts";
import { type AuditRule, compileRules } from "./rules.ts";

export function createAuditMiddleware(rules: AuditRule[]) {
  const match = compileRules(rules);
  return define.middleware(async (ctx) => {
    const res = await ctx.next();
    if (res.status < 400) {
      const matched = match(ctx.req.method, ctx.req.url);
      if (matched) {
        try {
          await audit(getDb(), {
            ...matched,
            actorId: ctx.state.member?.id,
            requestId: ctx.state.requestId,
            ip: clientHost(ctx.info),
          });
        } catch (err) {
          console.error("audit write FAILED:", matched.action, err);
        }
      }
    }
    return res;
  });
}

/** Routes audited by pattern. Handler-level audit() calls cover the rest. */
export const AUDIT_RULES: AuditRule[] = [
  { method: "POST", pathname: "/logout", action: "auth.logout" },
  { method: "POST", pathname: "/api/dev/backup", action: "backup.manual" },
];
