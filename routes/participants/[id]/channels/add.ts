import { HttpError } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import type { ContactChannelKind } from "../../../../lib/db/schema.ts";
import {
  addChannel,
  CHANNEL_KINDS,
  getParticipant,
  ParticipantError,
} from "../../../../lib/objects/participants.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    const form = await ctx.req.formData();
    const kind = String(form.get("kind") ?? "");
    const value = String(form.get("value") ?? "");
    if (!CHANNEL_KINDS.includes(kind as ContactChannelKind)) {
      throw new HttpError(400);
    }
    try {
      await addChannel(db, {
        participant,
        channel: { kind: kind as ContactChannelKind, value },
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof ParticipantError) throw new HttpError(400);
      throw err;
    }
    return ctx.redirect(`/participants/${participant.id}?tab=channels`, 303);
  },
});
