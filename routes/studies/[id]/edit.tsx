import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Study } from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  EDITABLE_STATES,
  getStudyFor,
  StudyError,
  updateStudy,
} from "../../../lib/objects/studies.ts";
import { Layout } from "../../../components/Layout.tsx";

interface Data {
  study: Study;
  error?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "researcher")) {
      throw new HttpError(403);
    }
    const found = await getStudyFor(getDb(), ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);
    if (!EDITABLE_STATES.includes(found.study.status)) throw new HttpError(409);
    return page<Data>({ study: found.study });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getStudyFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      const updated = await updateStudy(db, {
        study: found.study,
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? ""),
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/studies/${updated.id}`, 303);
    } catch (err) {
      if (err instanceof StudyError) {
        return page<Data>({ study: found.study, error: err.message }, {
          status: 400,
        });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout
    member={state.member!}
    pathname={url.pathname}
    title={`Edit: ${data.study.name}`}
  >
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
          value={data.study.name}
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
          {data.study.description}
        </textarea>
      </label>
      <div class="flex gap-2">
        <button
          type="submit"
          class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Save
        </button>
        <a
          href={`/studies/${data.study.id}`}
          class="rounded-card border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
        >
          Cancel
        </a>
      </div>
    </form>
  </Layout>
));
