// Milestone list (spec §3.7) shared by study and project timeline tabs.
// Server-rendered; every interaction is a small POST form.
import type { Member } from "../../lib/db/schema.ts";
import type { MilestoneWithMeta } from "../../lib/objects/milestones.ts";
import { StatusBadge } from "./StatusBadge.tsx";

const NEXT_STATUS = {
  pending: { to: "in_progress", label: "Start" },
  in_progress: { to: "done", label: "Done" },
  done: { to: "pending", label: "Reopen" },
} as const;

export function MilestoneList(props: {
  items: MilestoneWithMeta[];
  /** All milestones in scope, for dependency pickers and name lookups. */
  byId: Map<string, string>;
  canManage: boolean;
  /** Members offered as owners in the add form (study/project team). */
  owners: Member[];
  addAction: string;
  emptyMessage?: string;
}) {
  return (
    <div class="max-w-3xl space-y-4">
      <ul class="space-y-2">
        {props.items.length === 0 && (
          <p class="text-sm text-gray-500">
            {props.emptyMessage ?? "No milestones yet."}
          </p>
        )}
        {props.items.map(({ milestone, owner, dependsOn, blocked }) => (
          <li
            key={milestone.id}
            class="rounded-card border border-gray-200 bg-white px-3 py-2 text-sm"
            data-milestone-blocked={blocked ? "true" : "false"}
          >
            <div class="flex flex-wrap items-center gap-2">
              <StatusBadge status={milestone.status} />
              {blocked && <StatusBadge status="blocked" />}
              <span
                class={`font-medium ${
                  milestone.status === "done"
                    ? "text-gray-400 line-through"
                    : "text-gray-900"
                }`}
              >
                {milestone.title}
              </span>
              {milestone.dueOn && (
                <span class="text-xs text-gray-500">
                  due {milestone.dueOn.toISOString().slice(0, 10)}
                </span>
              )}
              {owner && (
                <span class="text-xs text-gray-500">· {owner.name}</span>
              )}
              {props.canManage && (
                <span class="ml-auto flex items-center gap-2">
                  <form
                    method="post"
                    action={`/milestones/${milestone.id}/status?to=${
                      NEXT_STATUS[milestone.status].to
                    }`}
                  >
                    <button
                      type="submit"
                      class="rounded-card border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
                    >
                      {NEXT_STATUS[milestone.status].label}
                    </button>
                  </form>
                  <a
                    href={`/milestones/${milestone.id}/edit`}
                    class="text-xs text-brand-700 hover:underline"
                  >
                    edit
                  </a>
                  <form
                    method="post"
                    action={`/milestones/${milestone.id}/delete`}
                    {...{
                      onsubmit:
                        "return confirm('Delete this milestone? Recorded in the audit log.')",
                    }}
                  >
                    <button
                      type="submit"
                      class="text-xs text-gray-400 hover:text-red-600"
                    >
                      delete
                    </button>
                  </form>
                </span>
              )}
            </div>
            {(dependsOn.length > 0 || props.canManage) && (
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {dependsOn.length > 0 && (
                  <span>
                    after: {dependsOn.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        {props.byId.get(id) ?? "?"}
                        {props.canManage && (
                          <form
                            method="post"
                            action={`/milestones/${milestone.id}/deps`}
                            class="inline"
                          >
                            <input type="hidden" name="action" value="remove" />
                            <input
                              type="hidden"
                              name="dependsOnId"
                              value={id}
                            />
                            <button
                              type="submit"
                              class="px-0.5 text-gray-400 hover:text-red-600"
                              title="Remove dependency"
                            >
                              ✕
                            </button>
                          </form>
                        )}
                      </span>
                    ))}
                  </span>
                )}
                {props.canManage && (
                  <form
                    method="post"
                    action={`/milestones/${milestone.id}/deps`}
                    class="inline-flex items-center gap-1"
                  >
                    <input type="hidden" name="action" value="add" />
                    <select
                      name="dependsOnId"
                      class="rounded border border-gray-200 px-1 py-0.5 text-xs"
                    >
                      {[...props.byId.entries()]
                        .filter(([id]) => id !== milestone.id)
                        .map(([id, title]) => (
                          <option key={id} value={id}>{title}</option>
                        ))}
                    </select>
                    <button
                      type="submit"
                      class="rounded border border-gray-200 px-1.5 py-0.5 text-xs hover:bg-gray-50"
                    >
                      + dep
                    </button>
                  </form>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {props.canManage && (
        <form
          method="post"
          action={props.addAction}
          class="flex flex-wrap items-end gap-2 rounded-card border border-gray-200 bg-white p-3 text-sm"
        >
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-500">Title</span>
            <input
              type="text"
              name="title"
              required
              class="w-56 rounded-card border border-gray-300 px-2 py-1"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-500">Due</span>
            <input
              type="date"
              name="dueOn"
              class="rounded-card border border-gray-300 px-2 py-1"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-gray-500">Owner</span>
            <select
              name="ownerId"
              class="rounded-card border border-gray-300 px-2 py-1"
            >
              <option value="">—</option>
              {props.owners.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            class="rounded-card border border-gray-300 px-3 py-1 hover:bg-gray-50"
          >
            Add milestone
          </button>
        </form>
      )}
    </div>
  );
}
