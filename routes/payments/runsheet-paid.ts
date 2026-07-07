// Marks every approved compensation of one method paid, with a shared
// transfer reference — the "I just paid the whole run sheet" action
// (assistant+, each payout audited, confirmations sent).
import { HttpError } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import {
  COMPENSATION_METHODS,
  listApprovedByMethod,
  markBatchPaid,
} from "../../lib/objects/compensations.ts";
import type { CompensationMethod } from "../../lib/db/schema.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const form = await ctx.req.formData();
    const method = String(form.get("method") ?? "");
    if (!COMPENSATION_METHODS.includes(method as CompensationMethod)) {
      throw new HttpError(400, "Unknown payment method.");
    }
    const db = getDb();
    const rows = await listApprovedByMethod(db, method as CompensationMethod);
    await markBatchPaid(db, {
      ids: rows.map((r) => r.compensation.id),
      actor: me,
      reference: String(form.get("reference") ?? ""),
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect("/payments", 303);
  },
});
