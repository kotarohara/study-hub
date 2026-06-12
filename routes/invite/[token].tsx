import { page } from "fresh";
import { define } from "../../utils.ts";
import { getConfig } from "../../lib/config.ts";
import { getDb } from "../../lib/db/client.ts";
import {
  acceptInvite,
  getPendingInvite,
  InviteError,
} from "../../lib/auth/invite.ts";
import { validatePassword } from "../../lib/auth/password.ts";
import { createSession, sessionCookie } from "../../lib/auth/session.ts";
import { clientHost, inviteAcceptLimiter } from "../../lib/auth/limiters.ts";

interface Data {
  valid: boolean;
  email?: string;
  error?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    const invite = await getPendingInvite(getDb(), ctx.params.token);
    if (!invite) return page<Data>({ valid: false }, { status: 404 });
    return page<Data>({ valid: true, email: invite.email });
  },
  async POST(ctx) {
    if (!inviteAcceptLimiter.check(`invite:${clientHost(ctx.info)}`)) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    const db = getDb();
    const invite = await getPendingInvite(db, ctx.params.token);
    if (!invite) return page<Data>({ valid: false }, { status: 404 });

    const form = await ctx.req.formData();
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");

    const problem = !name
      ? "Please enter your name."
      : validatePassword(password);
    if (problem) {
      return page<Data>(
        { valid: true, email: invite.email, error: problem },
        { status: 400 },
      );
    }

    try {
      const member = await acceptInvite(db, {
        token: ctx.params.token,
        name,
        password,
      });
      const { token, expiresAt } = await createSession(db, member.id);
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": sessionCookie(token, expiresAt, {
            secure: getConfig().APP_ENV === "production",
          }),
        },
      });
    } catch (err) {
      if (err instanceof InviteError) {
        return page<Data>({ valid: false }, { status: 409 });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data }) => (
  <main class="min-h-screen flex items-center justify-center bg-gray-50">
    {!data.valid
      ? (
        <div class="w-full max-w-sm bg-white rounded-lg shadow p-8">
          <h1 class="text-2xl font-bold mb-2">Invite not valid</h1>
          <p class="text-sm text-gray-600">
            This invite link is invalid, expired, or already used. Ask your PI
            for a new one.
          </p>
        </div>
      )
      : (
        <form
          method="post"
          class="w-full max-w-sm bg-white rounded-lg shadow p-8 flex flex-col gap-4"
        >
          <h1 class="text-2xl font-bold">Join StudyHub</h1>
          <p class="text-sm text-gray-600">
            Creating an account for <strong>{data.email}</strong>
          </p>
          {data.error && (
            <p class="text-red-700 bg-red-50 border border-red-200 rounded p-2 text-sm">
              {data.error}
            </p>
          )}
          <label class="flex flex-col gap-1 text-sm">
            Your name
            <input
              type="text"
              name="name"
              required
              class="border rounded px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Password (min 10 characters)
            <input
              type="password"
              name="password"
              required
              minlength={10}
              autocomplete="new-password"
              class="border rounded px-3 py-2"
            />
          </label>
          <button
            type="submit"
            class="bg-blue-600 text-white rounded px-3 py-2 font-medium hover:bg-blue-700"
          >
            Create account
          </button>
        </form>
      )}
  </main>
));
