// PI-approved PII purge (spec §3.4 erasure, §4 audited deletions).
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getParticipant } from "../../../lib/objects/participants.ts";
import { purgeParticipant } from "../../../lib/objects/withdrawal.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "pi")) throw new HttpError(403);
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    await purgeParticipant(db, {
      participant,
      actor: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect("/participants/retention", 303);
  },
});
