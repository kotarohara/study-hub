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
import { listConditions } from "../../../lib/objects/design.ts";
import { listDocumentsOfStudy } from "../../../lib/objects/documents.ts";
import type { Condition, Document } from "../../../lib/db/schema.ts";
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
  conditions: Condition[];
  documents: Document[];
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
    return page<Data>({
      found,
      activeTab,
      conditions: activeTab === "design"
        ? await listConditions(getDb(), found.study.id)
        : [],
      documents: activeTab === "documents"
        ? await listDocumentsOfStudy(getDb(), found.study.id)
        : [],
    });
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
          <div class="max-w-3xl space-y-4">
            <div class="flex gap-2">
              <a
                href={`/studies/${study.id}/onepager`}
                class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                One-pager
              </a>
              {EDITABLE_STATES.includes(study.status) && (
                <a
                  href={`/studies/${study.id}/design`}
                  class="rounded-card border border-brand-600 bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                >
                  Edit design
                </a>
              )}
            </div>
            <dl class="grid grid-cols-1 gap-x-8 gap-y-3 text-sm md:grid-cols-2">
              {[
                ["Research questions", study.researchQuestions],
                ["Hypotheses", study.hypotheses],
                ["Independent variables", study.independentVariables],
                ["Dependent variables", study.dependentVariables],
                ["Exclusion criteria", study.exclusionCriteria],
                ["Counterbalancing", study.counterbalancingScheme],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt class="text-xs uppercase tracking-wide text-gray-500">
                    {label}
                  </dt>
                  <dd class="whitespace-pre-wrap text-gray-900">
                    {value || <span class="text-gray-400">—</span>}
                  </dd>
                </div>
              ))}
              <div>
                <dt class="text-xs uppercase tracking-wide text-gray-500">
                  Design type / target N
                </dt>
                <dd class="text-gray-900">
                  {study.designType ?? "—"} / {study.targetN ?? "—"}
                </dd>
              </div>
              <div>
                <dt class="text-xs uppercase tracking-wide text-gray-500">
                  Conditions
                </dt>
                <dd class="text-gray-900">
                  {data.conditions.length === 0
                    ? <span class="text-gray-400">—</span>
                    : data.conditions.map((c) => c.name).join(", ")}
                </dd>
              </div>
            </dl>
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
            <a
              href={`/documents/new?study=${study.id}`}
              class="inline-block rounded-card border border-brand-600 bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              New document
            </a>
          </div>
        )}
      </DetailView>
    </Layout>
  );
});
