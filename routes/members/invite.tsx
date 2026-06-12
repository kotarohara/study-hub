// PI-only invite UI (wraps the same flow as POST /api/invites). Until the
// messaging core lands (Phase 3.2), the PI copies the generated link.
import { HttpError, page } from "fresh";
import { z } from "zod";
import { define } from "../../utils.ts";
import { getConfig } from "../../lib/config.ts";
import { getDb } from "../../lib/db/client.ts";
import { createInvite, InviteError } from "../../lib/auth/invite.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { audit } from "../../lib/audit/log.ts";
import { Layout } from "../../components/Layout.tsx";

interface Data {
  error?: string;
  inviteUrl?: string;
  invitedEmail?: string;
}

const ROLES = ["researcher", "assistant", "collaborator", "pi"] as const;

const FormSchema = z.object({
  email: z.email(),
  role: z.enum(ROLES),
});

export const handler = define.handlers({
  GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "pi")) throw new HttpError(403);
    return page<Data>({});
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "pi")) throw new HttpError(403);

    const form = await ctx.req.formData();
    const parsed = FormSchema.safeParse({
      email: form.get("email"),
      role: form.get("role"),
    });
    if (!parsed.success) {
      return page<Data>({ error: "Enter a valid email and role." }, {
        status: 400,
      });
    }

    try {
      const { token, invite } = await createInvite(getDb(), {
        email: parsed.data.email,
        role: parsed.data.role,
        invitedBy: me.id,
      });
      await audit(getDb(), {
        action: "member.invite_created",
        actorId: me.id,
        objectType: "invite",
        objectId: invite.id,
        details: { role: invite.role },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return page<Data>({
        inviteUrl: new URL(`/invite/${token}`, getConfig().APP_URL).href,
        invitedEmail: invite.email,
      });
    } catch (err) {
      if (err instanceof InviteError) {
        return page<Data>({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Invite member">
    <div class="max-w-lg space-y-4">
      {data.error && (
        <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {data.error}
        </p>
      )}
      {data.inviteUrl && (
        <div class="rounded-card border border-green-200 bg-green-50 p-3 text-sm">
          <p class="font-medium text-green-800">
            Invite created for {data.invitedEmail} (valid 7 days).
          </p>
          <p class="mt-1 text-green-900">
            Send them this link:{" "}
            <code class="break-all rounded bg-white px-1 py-0.5">
              {data.inviteUrl}
            </code>
          </p>
        </div>
      )}
      <form
        method="post"
        class="space-y-4 rounded-card border border-gray-200 bg-white p-4"
      >
        <label class="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            name="email"
            required
            class="rounded-card border border-gray-300 px-3 py-2"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Role
          <select
            name="role"
            class="rounded-card border border-gray-300 px-3 py-2"
          >
            {ROLES.map((role) => <option key={role} value={role}>{role}
            </option>)}
          </select>
        </label>
        <button
          type="submit"
          class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Create invite
        </button>
      </form>
    </div>
  </Layout>
));
