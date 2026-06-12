import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Member, Milestone } from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import {
  getMilestoneFor,
  MilestoneError,
  updateMilestone,
} from "../../../lib/objects/milestones.ts";
import { listProjectMembers } from "../../../lib/objects/projects.ts";
import { Layout } from "../../../components/Layout.tsx";
import { milestoneHome } from "./_shared.ts";

interface Data {
  milestone: Milestone;
  owners: Member[];
  error?: string;
}

function parseDate(raw: string): Date | null {
  if (!raw.trim()) return null;
  const d = new Date(raw + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new MilestoneError("Invalid date.");
  return d;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getMilestoneFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);
    return page<Data>({
      milestone: found.milestone,
      owners: await listProjectMembers(db, found.project.id),
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getMilestoneFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    try {
      await updateMilestone(db, {
        milestone: found.milestone,
        title: String(form.get("title") ?? ""),
        notes: String(form.get("notes") ?? ""),
        ownerId: String(form.get("ownerId") ?? "") || null,
        startsOn: parseDate(String(form.get("startsOn") ?? "")),
        dueOn: parseDate(String(form.get("dueOn") ?? "")),
        actor: me,
        requestId: ctx.state.requestId,
      });
      return ctx.redirect(milestoneHome(found.milestone), 303);
    } catch (err) {
      if (err instanceof MilestoneError) {
        return page<Data>(
          {
            milestone: found.milestone,
            owners: await listProjectMembers(db, found.project.id),
            error: err.message,
          },
          { status: 400 },
        );
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const { milestone } = data;
  return (
    <Layout
      member={state.member!}
      pathname={url.pathname}
      title={`Edit milestone: ${milestone.title}`}
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
          Title
          <input
            type="text"
            name="title"
            required
            value={milestone.title}
            class="rounded-card border border-gray-300 px-3 py-2"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Notes
          <textarea
            name="notes"
            rows={3}
            class="rounded-card border border-gray-300 px-3 py-2"
          >
            {milestone.notes}
          </textarea>
        </label>
        <div class="grid gap-4 md:grid-cols-3">
          <label class="flex flex-col gap-1 text-sm">
            Starts
            <input
              type="date"
              name="startsOn"
              value={milestone.startsOn?.toISOString().slice(0, 10) ?? ""}
              class="rounded-card border border-gray-300 px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Due
            <input
              type="date"
              name="dueOn"
              value={milestone.dueOn?.toISOString().slice(0, 10) ?? ""}
              class="rounded-card border border-gray-300 px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Owner
            <select
              name="ownerId"
              class="rounded-card border border-gray-300 px-3 py-2"
            >
              <option value="">—</option>
              {data.owners.map((m) => (
                <option
                  key={m.id}
                  value={m.id}
                  selected={milestone.ownerId === m.id}
                >
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="flex gap-2">
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Save
          </button>
          <a
            href={milestoneHome(milestone)}
            class="rounded-card border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </Layout>
  );
});
