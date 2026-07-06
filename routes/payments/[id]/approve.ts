// Approves a pending compensation (researcher+) — audited (spec §4).
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  approveCompensation,
  CompensationError,
} from "../../../lib/objects/compensations.ts";
import { getCompensationFor } from "../_shared.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const compensation = await getCompensationFor(db, me, ctx.params.id);
    if (!compensation) throw new HttpError(404);
    try {
      await approveCompensation(db, {
        compensation,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof CompensationError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }
    return ctx.redirect("/payments", 303);
  },
});
