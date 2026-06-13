import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import {
  allowedTransitions,
  EDITABLE_STATES,
  getStudyFor,
  isPilotStudy,
  STUDY_STEPS,
  type StudyStatus,
  type StudyWithProject,
} from "../../../lib/objects/studies.ts";
import { PilotBanner } from "../../../components/ooui/PilotBanner.tsx";
import { irbExpiryStatus } from "../../../lib/objects/irb.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { listConditions } from "../../../lib/objects/design.ts";
import { listDocumentsOfStudy } from "../../../lib/objects/documents.ts";
import {
  listMilestonesOfStudy,
  type MilestoneWithMeta,
} from "../../../lib/objects/milestones.ts";
import { listProjectMembers } from "../../../lib/objects/projects.ts";
import { MilestoneList } from "../../../components/ooui/MilestoneList.tsx";
import TimelineGantt from "../../../islands/TimelineGantt.tsx";
import { type GanttItem, ganttRange } from "../../../lib/ooui/gantt.ts";
import type {
  Condition,
  Document,
  Member,
  Participant,
} from "../../../lib/db/schema.ts";
import {
  type EnrollmentRow,
  listEnrollmentsOfStudy,
} from "../../../lib/objects/enrollments.ts";
import { listParticipants } from "../../../lib/objects/participants.ts";
import { EnrollmentPanel } from "../../../components/EnrollmentPanel.tsx";
import {
  type ConsentStatus,
  consentStatusOfStudy,
} from "../../../lib/objects/consents.ts";
import { type StudyFunnel, studyFunnel } from "../../../lib/objects/funnel.ts";
import { FunnelPanel } from "../../../components/FunnelPanel.tsx";
import {
  listSessionsOfStudy,
  type SessionRow,
} from "../../../lib/objects/sessions.ts";
import { isTerminal } from "../../../lib/objects/enrollments.ts";
import { SessionPanel } from "../../../components/SessionPanel.tsx";
import { audit } from "../../../lib/audit/log.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
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
  milestones: MilestoneWithMeta[];
  team: Member[];
  enrollmentRows: EnrollmentRow[];
  pool: Participant[];
  consent: [string, ConsentStatus][];
  funnel: StudyFunnel | null;
  sessions: SessionRow[];
  bookable: { id: string; code: string }[];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "design", label: "Design" },
  { id: "participants", label: "Participants" },
  { id: "recruitment", label: "Recruitment" },
  { id: "sessions", label: "Sessions" },
  { id: "documents", label: "Documents" },
  { id: "timeline", label: "Timeline" },
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
    const enrollmentRows = activeTab === "participants"
      ? await listEnrollmentsOfStudy(getDb(), found.study.id)
      : [];
    return page<Data>({
      found,
      activeTab,
      conditions: activeTab === "design"
        ? await listConditions(getDb(), found.study.id)
        : [],
      documents: activeTab === "documents"
        ? await listDocumentsOfStudy(getDb(), found.study.id)
        : [],
      milestones: activeTab === "timeline"
        ? await listMilestonesOfStudy(getDb(), found.study.id)
        : [],
      team: activeTab === "timeline"
        ? await listProjectMembers(getDb(), found.project.id)
        : [],
      enrollmentRows,
      pool: activeTab === "participants"
        ? await loadEnrollablePool({
          member: ctx.state.member!,
          studyId: found.study.id,
          requestId: ctx.state.requestId,
          ip: clientHost(ctx.info),
        })
        : [],
      consent: activeTab === "participants"
        ? [...(await consentStatusOfStudy(
          getDb(),
          found.study,
          enrollmentRows.map((r) => r.enrollment),
        )).entries()]
        : [],
      funnel: activeTab === "recruitment"
        ? await studyFunnel(getDb(), found.study)
        : null,
      sessions: activeTab === "sessions"
        ? await listSessionsOfStudy(getDb(), found.study.id)
        : [],
      bookable: activeTab === "sessions"
        ? (await listEnrollmentsOfStudy(getDb(), found.study.id))
          .filter((r) => !isTerminal(r.enrollment.status))
          .map((r) => ({ id: r.enrollment.id, code: r.participantCode }))
        : [],
    });
  },
});

/** Pool minus already-enrolled and do-not-contact, for the enroll
 * dropdown (assistant+). Names are decrypted PII -> audited. */
async function loadEnrollablePool(
  opts: {
    member: Member;
    studyId: string;
    requestId: string;
    ip: string;
  },
): Promise<Participant[]> {
  if (!hasRole(opts.member.role, "assistant")) return [];
  const db = getDb();
  const enrolled = new Set(
    (await listEnrollmentsOfStudy(db, opts.studyId)).map(
      (r) => r.enrollment.participantId,
    ),
  );
  const pool = (await listParticipants(db)).filter(
    (p) => !enrolled.has(p.id) && !p.doNotContact,
  );
  if (pool.length > 0) {
    await audit(db, {
      action: "pii.list_viewed",
      actorId: opts.member.id,
      objectType: "participant",
      details: { count: pool.length, via: "study_enroll" },
      requestId: opts.requestId,
      ip: opts.ip,
    });
  }
  return pool;
}

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
      ...(!isPilotStudy(study)
        ? [{
          id: "screener",
          label: "Screener",
          href: `/studies/${study.id}/screener`,
          method: "get" as const,
        }]
        : []),
      {
        id: "pathway",
        label: "Change pathway",
        href: `/studies/${study.id}/pathway`,
        method: "get",
        minRole: "pi",
        enabledIn: EDITABLE_STATES,
      },
      ...(study.oversightPathway === "irb_reviewed"
        ? [{
          id: "irb",
          label: "Record IRB approval",
          href: `/studies/${study.id}/irb`,
          method: "get" as const,
          minRole: "pi" as const,
        }]
        : []),
      ...(isPilotStudy(study)
        ? [{
          id: "promote",
          label: "Promote to full study",
          href: `/studies/${study.id}/promote`,
          tone: "primary" as const,
          minRole: "researcher" as const,
          confirm:
            "Create an IRB-reviewed copy of this pilot's design? Pilot data never carries over.",
        }]
        : []),
      {
        id: "duplicate",
        label: "Duplicate",
        href: `/studies/${study.id}/duplicate`,
        minRole: isPilotStudy(study) ? "pi" : "researcher",
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
          ...(study.irbProtocolNumber
            ? [
              { label: "IRB protocol", value: study.irbProtocolNumber },
              {
                label: "IRB approval",
                value: `${
                  study.irbApprovedOn?.toISOString().slice(0, 10) ?? "—"
                } → ${study.irbExpiresOn?.toISOString().slice(0, 10) ?? "—"}`,
              },
            ]
            : []),
        ]}
        tabs={TABS}
        activeTab={data.activeTab}
        baseHref={`/studies/${study.id}`}
        actions={actions}
      >
        {isPilotStudy(study) && (
          <div class="mb-4">
            <PilotBanner />
          </div>
        )}
        {(() => {
          const expiry = irbExpiryStatus(study);
          return (expiry === "expired" || expiry === "expiring_soon") && (
            <div
              class={`mb-4 rounded-card border px-4 py-2 text-sm font-medium ${
                expiry === "expired"
                  ? "border-red-300 bg-red-50 text-red-800"
                  : "border-amber-300 bg-amber-50 text-amber-800"
              }`}
            >
              {expiry === "expired"
                ? `IRB approval EXPIRED on ${
                  study.irbExpiresOn!.toISOString().slice(0, 10)
                } — recruiting is blocked until renewal is recorded.`
                : `IRB approval expires on ${
                  study.irbExpiresOn!.toISOString().slice(0, 10)
                } — plan the renewal.`}
            </div>
          );
        })()}
        <div class="mb-4">
          <Stepper steps={STUDY_STEPS} current={study.status} />
        </div>

        {data.activeTab === "overview" && (
          <div class="max-w-2xl space-y-3">
            <p class="whitespace-pre-wrap text-sm text-gray-700">
              {study.description || "No description."}
            </p>
            {study.oversightPathway === "irb_exempt" && (
              <p class="text-sm text-gray-600">
                <span class="font-medium">IRB exemption reference:</span>{" "}
                {study.irbExemptionReference}
              </p>
            )}
            {isPilotStudy(study) && (
              <p class="text-sm text-gray-600">
                <span class="font-medium">PI justification:</span>{" "}
                {study.pilotJustification}
              </p>
            )}
          </div>
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
        {data.activeTab === "participants" && (
          <EnrollmentPanel
            study={study}
            rows={data.enrollmentRows}
            pool={data.pool}
            consent={new Map(data.consent)}
            canOperate={hasRole(me.role, "assistant")}
            canPilotToggle={hasRole(me.role, "researcher")}
          />
        )}
        {data.activeTab === "recruitment" && data.funnel && (
          <FunnelPanel
            study={study}
            funnel={data.funnel}
            canOperate={hasRole(me.role, "assistant")}
          />
        )}
        {data.activeTab === "sessions" && (
          <SessionPanel
            study={study}
            rows={data.sessions}
            bookable={data.bookable}
            canOperate={hasRole(me.role, "assistant")}
            canManage={hasRole(me.role, "researcher")}
          />
        )}
        {data.activeTab === "timeline" && (
          <div class="space-y-4">
            {(() => {
              const items: GanttItem[] = data.milestones.map((m) => ({
                id: m.milestone.id,
                title: m.milestone.title,
                start: m.milestone.startsOn?.toISOString().slice(0, 10) ??
                  null,
                due: m.milestone.dueOn?.toISOString().slice(0, 10) ?? null,
                status: m.milestone.status,
                blocked: m.blocked,
              }));
              const range = ganttRange(items);
              return range && (
                <TimelineGantt
                  items={items}
                  rangeStartIso={range.start.toISOString().slice(0, 10)}
                  rangeDays={range.days}
                  editable={hasRole(me.role, "researcher")}
                />
              );
            })()}
            {hasRole(me.role, "researcher") && (
              <form
                method="post"
                action={`/studies/${study.id}/milestones/apply-template`}
              >
                <button
                  type="submit"
                  class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Apply {study.methodology.replaceAll("_", " ")}{" "}
                  milestone template
                </button>
              </form>
            )}
            <MilestoneList
              items={data.milestones}
              byId={new Map(
                data.milestones.map((
                  m,
                ) => [m.milestone.id, m.milestone.title]),
              )}
              canManage={hasRole(me.role, "researcher")}
              owners={data.team}
              addAction={`/studies/${study.id}/milestones/add`}
              emptyMessage="No milestones yet — add one or apply the methodology template."
            />
          </div>
        )}
      </DetailView>
    </Layout>
  );
});
