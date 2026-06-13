// Removing a channel deletes stored PII → audited in the domain layer.
import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import {
  getParticipant,
  removeChannel,
} from "../../../../lib/objects/participants.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    const form = await ctx.req.formData();
    const channelId = String(form.get("channelId") ?? "");
    if (!channelId) throw new HttpError(400);

    await removeChannel(db, {
      participant,
      channelId,
      actor: me,
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });
    return ctx.redirect(`/participants/${participant.id}?tab=channels`, 303);
  },
});
