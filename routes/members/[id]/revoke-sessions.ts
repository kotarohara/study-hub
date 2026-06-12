// "Sign out everywhere": destroys all sessions of a member. PI can revoke
// anyone's; members can revoke their own. Audited.
import { HttpError } from "fresh";
import { eq } from "drizzle-orm";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { members } from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { destroyMemberSessions } from "../../../lib/auth/session.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    const isSelf = me.id === ctx.params.id;
    if (!isSelf && !hasRole(me.role, "pi")) throw new HttpError(403);

    const db = getDb();
    const subject = await db.query.members.findFirst({
      where: eq(members.id, ctx.params.id),
    });
    if (!subject) throw new HttpError(404);

    const revoked = await destroyMemberSessions(db, subject.id);
    await audit(db, {
      action: "member.sessions_revoked",
      actorId: me.id,
      objectType: "member",
      objectId: subject.id,
      details: { revoked, self: isSelf },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    // Self-revocation killed the current session too → back to login.
    return ctx.redirect(isSelf ? "/login" : `/members/${subject.id}`, 303);
  },
});
