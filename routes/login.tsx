import { page } from "fresh";
import { define } from "../utils.ts";
import { getConfig } from "../lib/config.ts";
import { getDb } from "../lib/db/client.ts";
import { authenticate } from "../lib/auth/login.ts";
import { createSession, sessionCookie } from "../lib/auth/session.ts";
import { clientHost, loginLimiter } from "../lib/auth/limiters.ts";

interface Data {
  error?: string;
  next: string;
}

/** Only same-site relative paths are allowed as post-login redirects. */
function safeNext(raw: FormDataEntryValue | string | null): string {
  const next = typeof raw === "string" ? raw : "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export const handler = define.handlers({
  GET(ctx) {
    if (ctx.state.member) return ctx.redirect("/");
    return page<Data>({ next: safeNext(ctx.url.searchParams.get("next")) });
  },
  async POST(ctx) {
    if (!loginLimiter.check(`login:${clientHost(ctx.info)}`)) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    const form = await ctx.req.formData();
    const next = safeNext(form.get("next"));
    const member = await authenticate(
      getDb(),
      String(form.get("email") ?? ""),
      String(form.get("password") ?? ""),
    );
    if (!member) {
      return page<Data>(
        { error: "Invalid email or password.", next },
        { status: 401 },
      );
    }
    const { token, expiresAt } = await createSession(getDb(), member.id);
    return new Response(null, {
      status: 303,
      headers: {
        location: next,
        "set-cookie": sessionCookie(token, expiresAt, {
          secure: getConfig().APP_ENV === "production",
        }),
      },
    });
  },
});

export default define.page<typeof handler>(({ data }) => (
  <main class="min-h-screen flex items-center justify-center bg-gray-50">
    <form
      method="post"
      class="w-full max-w-sm bg-white rounded-lg shadow p-8 flex flex-col gap-4"
    >
      <h1 class="text-2xl font-bold">Sign in to StudyHub</h1>
      {data.error && (
        <p class="text-red-700 bg-red-50 border border-red-200 rounded p-2 text-sm">
          {data.error}
        </p>
      )}
      <input type="hidden" name="next" value={data.next} />
      <label class="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          name="email"
          required
          autocomplete="username"
          class="border rounded px-3 py-2"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Password
        <input
          type="password"
          name="password"
          required
          autocomplete="current-password"
          class="border rounded px-3 py-2"
        />
      </label>
      <button
        type="submit"
        class="bg-blue-600 text-white rounded px-3 py-2 font-medium hover:bg-blue-700"
      >
        Sign in
      </button>
      <p class="text-xs text-gray-500">
        No account? Ask your PI for an invite — there is no self-signup.
      </p>
    </form>
  </main>
));
