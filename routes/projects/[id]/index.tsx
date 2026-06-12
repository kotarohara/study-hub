import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type {
  Document,
  Member,
  Project,
  Study,
} from "../../../lib/db/schema.ts";
import { listDocumentsOfProject } from "../../../lib/objects/documents.ts";
import {
  getProjectFor,
  listAddableMembers,
  listProjectMembers,
} from "../../../lib/objects/projects.ts";
import { listStudiesOfProject } from "../../../lib/objects/studies.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { Layout } from "../../../components/Layout.tsx";
import { DetailView } from "../../../components/ooui/DetailView.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";
import { resolveActions } from "../../../lib/ooui/actions.ts";

interface Data {
  project: Project;
  activeTab: string;
  projectMembers: Member[];
  addable: Member[];
  studies: Study[];
  documents: Document[];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "studies", label: "Studies" },
  { id: "documents", label: "Documents" },
];

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const project = await getProjectFor(db, ctx.state.member!, ctx.params.id);
    if (!project) throw new HttpError(404);

    const activeTab = TABS.some((t) => t.id === ctx.url.searchParams.get("tab"))
      ? ctx.url.searchParams.get("tab")!
      : "overview";

    const onMembersTab = activeTab === "members";
    return page<Data>({
      project,
      activeTab,
      projectMembers: onMembersTab
        ? await listProjectMembers(db, project.id)
        : [],
      addable: onMembersTab ? await listAddableMembers(db, project.id) : [],
      studies: activeTab === "studies"
        ? await listStudiesOfProject(db, project.id)
        : [],
      documents: activeTab === "documents"
        ? await listDocumentsOfProject(db, project.id)
        : [],
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { project } = data;
  const canManage = hasRole(me.role, "researcher");

  const actions = resolveActions(
    [
      {
        id: "edit",
        label: "Edit",
        href: `/projects/${project.id}/edit`,
        method: "get",
        minRole: "researcher",
        enabledIn: ["active"],
      },
      {
        id: "archive",
        label: "Archive",
        href: `/projects/${project.id}/archive`,
        tone: "danger",
        minRole: "researcher",
        enabledIn: ["active"],
        confirm: `Archive “${project.name}”? It becomes read-only.`,
      },
      {
        id: "unarchive",
        label: "Unarchive",
        href: `/projects/${project.id}/unarchive`,
        minRole: "researcher",
        enabledIn: ["archived"],
      },
    ],
    { status: project.status, role: me.role },
  ).filter((a) => a.enabled || a.id === "edit"); // hide irrelevant state action

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="▣"
        typeLabel="Project"
        title={project.name}
        status={project.status}
        properties={[
          {
            label: "Created",
            value: project.createdAt.toISOString().slice(0, 10),
          },
          {
            label: "Updated",
            value: project.updatedAt.toISOString().slice(0, 10),
          },
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={`/projects/${project.id}`}
        actions={actions}
      >
        {data.activeTab === "overview" && (
          <p class="max-w-2xl whitespace-pre-wrap text-sm text-gray-700">
            {project.description || "No description."}
          </p>
        )}

        {data.activeTab === "members" && (
          <div class="space-y-4">
            <div class="flex flex-wrap gap-2">
              {data.projectMembers.length === 0 && (
                <p class="text-sm text-gray-500">No members yet.</p>
              )}
              {data.projectMembers.map((m) => (
                <span key={m.id} class="inline-flex items-center gap-1">
                  <Chip
                    href={`/members/${m.id}`}
                    icon="♟"
                    label={m.name}
                    status={m.role}
                  />
                  {canManage && project.status === "active" && (
                    <form
                      method="post"
                      action={`/projects/${project.id}/members/remove`}
                    >
                      <input type="hidden" name="memberId" value={m.id} />
                      <button
                        type="submit"
                        class="rounded px-1 text-gray-400 hover:text-red-600"
                        title={`Remove ${m.name} from this project`}
                      >
                        ✕
                      </button>
                    </form>
                  )}
                </span>
              ))}
            </div>

            {canManage && project.status === "active" &&
              data.addable.length > 0 && (
              <form
                method="post"
                action={`/projects/${project.id}/members/add`}
                class="flex items-center gap-2"
              >
                <select
                  name="memberId"
                  class="rounded-card border border-gray-300 px-3 py-1.5 text-sm"
                >
                  {data.addable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.role})
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Add member
                </button>
              </form>
            )}
          </div>
        )}

        {data.activeTab === "documents" && (
          <div class="space-y-4">
            <div class="flex flex-wrap gap-2">
              {data.documents.length === 0 && (
                <p class="text-sm text-gray-500">No documents yet.</p>
              )}
              {data.documents.map((d) => (
                <Chip
                  key={d.id}
                  href={`/documents/${d.id}`}
                  icon="▤"
                  label={d.title}
                  sublabel={`${
                    d.kind.replaceAll("_", " ")
                  } · v${d.currentVersion}`}
                  status={d.reviewStatus}
                />
              ))}
            </div>
            {canManage && project.status === "active" && (
              <a
                href={`/documents/new?project=${project.id}`}
                class="inline-block rounded-card border border-brand-600 bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                New document
              </a>
            )}
          </div>
        )}

        {data.activeTab === "studies" && (
          <div class="space-y-4">
            <div class="flex flex-wrap gap-2">
              {data.studies.length === 0 && (
                <p class="text-sm text-gray-500">No studies yet.</p>
              )}
              {data.studies.map((s) => (
                <Chip
                  key={s.id}
                  href={`/studies/${s.id}`}
                  icon="⚗"
                  label={s.name}
                  sublabel={s.methodology.replaceAll("_", " ")}
                  status={s.status}
                />
              ))}
            </div>
            {canManage && project.status === "active" && (
              <a
                href={`/studies/new?project=${project.id}`}
                class="inline-block rounded-card border border-brand-600 bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                New study
              </a>
            )}
          </div>
        )}
      </DetailView>
    </Layout>
  );
});
