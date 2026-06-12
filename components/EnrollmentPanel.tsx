// "Participants" tab of the study detail view: enrollment table with
// lifecycle actions, condition assignment, pilot flags, and manual
// enrollment from the pool. Rows show pseudonymous codes only; the pool
// dropdown (names) is a PII view, audited by the study route handler.
import type { Participant, Study } from "../lib/db/schema.ts";
import {
  allowedEnrollmentTransitions,
  type EnrollmentRow,
  type EnrollmentStatus,
  isTerminal,
} from "../lib/objects/enrollments.ts";
import { isPilotStudy } from "../lib/objects/studies.ts";
import { StatusBadge } from "./ooui/StatusBadge.tsx";

const TRANSITION_LABELS: Record<EnrollmentStatus, string> = {
  screened: "Screened",
  eligible: "Mark eligible",
  consented: "Record consent",
  active: "Activate",
  completed: "Complete",
  withdrawn: "Withdraw",
  excluded: "Exclude",
};

const EXIT_STATES: EnrollmentStatus[] = ["withdrawn", "excluded"];

function TransitionButtons(props: { row: EnrollmentRow }) {
  const { enrollment } = props.row;
  return (
    <span class="inline-flex flex-wrap items-center gap-1.5">
      {allowedEnrollmentTransitions(enrollment.status).map((to) => (
        <form
          key={to}
          method="post"
          action={`/enrollments/${enrollment.id}/transition`}
          class="inline"
          data-confirm={EXIT_STATES.includes(to)
            ? `${
              TRANSITION_LABELS[to].split(" ")[0]
            } ${props.row.participantCode} from this study? This is final.`
            : undefined}
        >
          <input type="hidden" name="to" value={to} />
          <button
            type="submit"
            class={`rounded-card border px-2 py-1 text-xs ${
              EXIT_STATES.includes(to)
                ? "border-red-200 text-red-700 hover:bg-red-50"
                : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {TRANSITION_LABELS[to]}
          </button>
        </form>
      ))}
    </span>
  );
}

export function EnrollmentPanel(props: {
  study: Study;
  rows: EnrollmentRow[];
  /** Pool participants not yet enrolled (assistant+ only, else empty). */
  pool: Participant[];
  canOperate: boolean;
  canPilotToggle: boolean;
}) {
  const { study, rows } = props;
  const pilotStudy = isPilotStudy(study);

  return (
    <div class="space-y-6">
      {rows.length === 0
        ? (
          <p class="text-sm text-gray-500">
            No enrollments yet — {pilotStudy
              ? "pilot studies recruit manually-added participants only."
              : "enroll from the pool below or share the screener link."}
          </p>
        )
        : (
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th class="py-2 pr-4">Participant</th>
                <th class="py-2 pr-4">Status</th>
                <th class="py-2 pr-4">Condition</th>
                <th class="py-2 pr-4">Enrolled</th>
                {props.canOperate && <th class="py-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.enrollment.id} class="border-b border-gray-100">
                  <td class="py-2 pr-4">
                    <a
                      href={`/participants/${row.enrollment.participantId}`}
                      class="font-medium text-brand-700 hover:underline"
                    >
                      {row.participantCode}
                    </a>
                    {row.enrollment.isPilot && (
                      <span class="ml-2">
                        <StatusBadge status="pilot" />
                      </span>
                    )}
                  </td>
                  <td class="py-2 pr-4">
                    <StatusBadge status={row.enrollment.status} />
                  </td>
                  <td class="py-2 pr-4">
                    {row.conditionName ??
                      (props.canOperate &&
                          ["consented", "active"].includes(
                            row.enrollment.status,
                          )
                        ? (
                          <form
                            method="post"
                            action={`/enrollments/${row.enrollment.id}/assign`}
                            class="inline"
                          >
                            <button
                              type="submit"
                              class="rounded-card border border-brand-600 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50"
                            >
                              Assign condition
                            </button>
                          </form>
                        )
                        : "—")}
                  </td>
                  <td class="py-2 pr-4">
                    {row.enrollment.createdAt.toISOString().slice(0, 10)}
                  </td>
                  {props.canOperate && (
                    <td class="py-2">
                      <TransitionButtons row={row} />
                      {props.canPilotToggle && !pilotStudy &&
                        !isTerminal(row.enrollment.status) && (
                        <form
                          method="post"
                          action={`/enrollments/${row.enrollment.id}/pilot`}
                          class="ml-1.5 inline"
                        >
                          <button
                            type="submit"
                            class="rounded-card border border-purple-200 px-2 py-1 text-xs text-purple-700 hover:bg-purple-50"
                            title="Pilot data is excluded from datasets, quotas and exports"
                          >
                            {row.enrollment.isPilot
                              ? "Unmark pilot"
                              : "Mark pilot"}
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {props.canOperate && props.pool.length > 0 && (
        <form
          method="post"
          action={`/studies/${study.id}/enrollments/add`}
          class="flex flex-wrap items-center gap-2"
        >
          <select
            name="participantId"
            required
            class="rounded-card border border-gray-300 px-3 py-1.5 text-sm"
          >
            {props.pool.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          {!pilotStudy && (
            <label class="flex items-center gap-1.5 text-sm text-gray-700">
              <input type="checkbox" name="isPilot" value="1" />
              pilot enrollment (dry run)
            </label>
          )}
          <button
            type="submit"
            class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Enroll
          </button>
        </form>
      )}
    </div>
  );
}
