import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import {
  allowedTransitions,
  EDITABLE_STATES,
  getStudyFor,
  STUDY_STEPS,
  type StudyStatus,
  type StudyWithProject,
} from "../../../lib/objects/studies.ts";
import { Layout } from "../../../components/Layout.tsx";
import { DetailView } from "../../../components/ooui/DetailView.tsx";
import { Stepper } from "../../../components/ooui/Stepper.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";
import { StatusBadge } from "../../../components/ooui/StatusBadge.tsx";
import {
  type ObjectAction,
  resolveActions,
} from "../../../lib/ooui/actions.ts";

interface Data {
  found: StudyWithProject;
  activeTab: string;
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "design", label: "Design" },
  { id: "documents", label: "Documents" },
];

const TRANSITION_LABELS: Partial<Record<StudyStatus, string>> = {
  irb_review: "Submit for IRB review",
  draft: "Return to draft",
  recruiting: "Start recruiting",
  running: "Start running",
  analysis: "Begin analysis",
};

export const handler = define.handlers({
  async GET(ctx) {
    const found = await getStudyFor(getDb(), ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);
    const activeTab = TABS.some((t) => t.id === ctx.url.searchParams.get("tab"))
      ? ctx.url.searchParams.get("tab")!
      : "overview";
    return page<Data>({ found, activeTab });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { study, project } = data.found;

  const transitionActions: ObjectAction[] = allowedTransitions(study.status)
    .map((to) => ({
      id: `to-${to}`,
      label: TRANSITION_LABELS[to] ?? to,
      href: `/studies/${study.id}/transition?to=${to}`,
      tone: to === "draft" ? "default" as const : "primary" as const,
      minRole: "researcher" as const,
    }));

  const actions = resolveActions(
    [
      ...transitionActions,
      {
        id: "edit",
        label: "Edit",
        href: `/studies/${study.id}/edit`,
        method: "get",
        minRole: "researcher",
        enabledIn: EDITABLE_STATES,
      },
      {
        id: "duplicate",
        label: "Duplicate",
        href: `/studies/${study.id}/duplicate`,
        minRole: "researcher",
        confirm:
          "Duplicate this study? The design is copied into a new draft; participants and data never carry over.",
      },
      ...(study.status === "archived"
        ? [{
          id: "unarchive",
          label: "Unarchive",
          href: `/studies/${study.id}/unarchive`,
          minRole: "researcher" as const,
        }]
        : [{
          id: "archive",
          label: "Archive",
          href: `/studies/${study.id}/archive`,
          tone: "danger" as const,
          minRole: "researcher" as const,
          confirm: `Archive “${study.name}”?`,
        }]),
    ],
    { status: study.status, role: me.role },
  );

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="⚗"
        typeLabel="Study"
        title={study.name}
        status={study.status}
        properties={[
          {
            label: "Project",
            value: (
              <Chip
                href={`/projects/${project.id}`}
                icon="▣"
                label={project.name}
              />
            ),
          },
          {
            label: "Methodology",
            value: study.methodology.replaceAll("_", " "),
          },
          {
            label: "Oversight",
            value: <StatusBadge status={study.oversightPathway} />,
          },
          {
            label: "Created",
            value: study.createdAt.toISOString().slice(0, 10),
          },
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={`/studies/${study.id}`}
        actions={actions}
      >
        <div class="mb-4">
          <Stepper steps={STUDY_STEPS} current={study.status} />
        </div>

        {data.activeTab === "overview" && (
          <p class="max-w-2xl whitespace-pre-wrap text-sm text-gray-700">
            {study.description || "No description."}
          </p>
        )}
        {data.activeTab === "design" && (
          <p class="text-sm text-gray-600">
            The structured design editor (research questions, variables,
            conditions, target N) arrives in Phase 1.3.
          </p>
        )}
        {data.activeTab === "documents" && (
          <p class="text-sm text-gray-600">
            IRB protocols and consent documents arrive in Phase 1.5.
          </p>
        )}
      </DetailView>
    </Layout>
  );
});
