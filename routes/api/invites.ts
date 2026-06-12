// PI-only invite creation. Returns the invite link; emailing it arrives
// with the messaging core (Phase 3.2). UI lands with the OOUI shell (0.6).
import { HttpError } from "fresh";
import { z } from "zod";
import { define } from "../../utils.ts";
import { getConfig } from "../../lib/config.ts";
import { getDb } from "../../lib/db/client.ts";
import { createInvite, InviteError } from "../../lib/auth/invite.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { audit } from "../../lib/audit/log.ts";

const InviteBody = z.object({
  email: z.email(),
  role: z.enum(["pi", "researcher", "assistant", "collaborator"]),
});

export const handler = define.handlers({
  async POST(ctx) {
    const member = ctx.state.member;
    if (!member) throw new HttpError(401);
    if (!hasRole(member.role, "pi")) throw new HttpError(403);

    const body = InviteBody.safeParse(await ctx.req.json().catch(() => null));
    if (!body.success) {
      return Response.json(
        { error: z.prettifyError(body.error) },
        { status: 400 },
      );
    }

    try {
      const { token, invite } = await createInvite(getDb(), {
        email: body.data.email,
        role: body.data.role,
        invitedBy: member.id,
      });
      await audit(getDb(), {
        action: "member.invite_created",
        actorId: member.id,
        objectType: "invite",
        objectId: invite.id,
        details: { role: invite.role },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return Response.json(
        {
          url: new URL(`/invite/${token}`, getConfig().APP_URL).href,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof InviteError) {
        return Response.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  },
});
