import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { createProject, ProjectError } from "../../lib/objects/projects.ts";
import { Layout } from "../../components/Layout.tsx";

interface Data {
  error?: string;
  name?: string;
  description?: string;
}

export const handler = define.handlers({
  GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "researcher")) {
      throw new HttpError(403);
    }
    return page<Data>({});
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);

    const form = await ctx.req.formData();
    const name = String(form.get("name") ?? "");
    const description = String(form.get("description") ?? "");
    try {
      const project = await createProject(getDb(), {
        name,
        description,
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/projects/${project.id}`, 303);
    } catch (err) {
      if (err instanceof ProjectError) {
        return page<Data>({ error: err.message, name, description }, {
          status: 400,
        });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="New project">
    <form
      method="post"
      class="max-w-lg space-y-4 rounded-card border border-gray-200 bg-white p-4"
    >
      {data.error && (
        <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {data.error}
        </p>
      )}
      <label class="flex flex-col gap-1 text-sm">
        Name
        <input
          type="text"
          name="name"
          required
          value={data.name ?? ""}
          class="rounded-card border border-gray-300 px-3 py-2"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Description
        <textarea
          name="description"
          rows={4}
          class="rounded-card border border-gray-300 px-3 py-2"
        >
          {data.description ?? ""}
        </textarea>
      </label>
      <button
        type="submit"
        class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Create project
      </button>
    </form>
  </Layout>
));
