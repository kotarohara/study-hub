// "Sessions" tab of the study detail view (spec §4 kept-feature 2):
// publish open slots, book/unbook on behalf of participants, and record
// completion or no-shows. Self-booking happens off a magic link issued
// per enrollment. Pseudonymous codes only — no PII on this tab.
import type { Study } from "../lib/db/schema.ts";
import {
  allowedSessionTransitions,
  type SessionRow,
} from "../lib/objects/sessions.ts";
import { StatusBadge } from "./ooui/StatusBadge.tsx";

function fmt(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

const INPUT = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

export function SessionPanel(props: {
  study: Study;
  rows: SessionRow[];
  /** Non-terminal enrollments (codes only) available to book. */
  bookable: { id: string; code: string }[];
  canOperate: boolean; // assistant+
  canManage: boolean; // researcher+
}) {
  const { study, rows } = props;
  const openSlots = rows.filter((r) => r.session.status === "open");

  return (
    <div class="space-y-8">
      {props.canManage && (
        <form
          method="post"
          action={`/studies/${study.id}/sessions/add`}
          class="flex flex-wrap items-end gap-3 rounded-card border border-gray-200 bg-white p-4"
        >
          <label class="flex flex-col gap-1 text-sm">
            Starts
            <input
              type="datetime-local"
              name="startsAt"
              required
              class={INPUT}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Ends
            <input type="datetime-local" name="endsAt" required class={INPUT} />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Location / equipment
            <input
              type="text"
              name="location"
              placeholder="Lab 3A, Zoom…"
              class={INPUT}
            />
          </label>
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Publish slot
          </button>
        </form>
      )}

      <section class="space-y-2">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold text-gray-900">
            Schedule ({rows.length})
          </h2>
          {rows.length > 0 && (
            <a
              href={`/studies/${study.id}/calendar.ics`}
              class="text-xs text-brand-700 hover:underline"
            >
              Calendar feed (.ics) ↓
            </a>
          )}
        </div>
        {rows.length === 0
          ? <p class="text-sm text-gray-500">No sessions yet.</p>
          : (
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th class="py-2 pr-4">When</th>
                  <th class="py-2 pr-4">Location</th>
                  <th class="py-2 pr-4">Status</th>
                  <th class="py-2 pr-4">Participant</th>
                  {props.canOperate && <th class="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.session.id} class="border-b border-gray-100">
                    <td class="py-2 pr-4">
                      {fmt(row.session.startsAt)} –{" "}
                      {fmt(row.session.endsAt).slice(11)}
                    </td>
                    <td class="py-2 pr-4">{row.session.location || "—"}</td>
                    <td class="py-2 pr-4">
                      <StatusBadge status={row.session.status} />
                      {row.session.isPilot && (
                        <span class="ml-1">
                          <StatusBadge status="pilot" />
                        </span>
                      )}
                    </td>
                    <td class="py-2 pr-4">
                      {row.participantCode
                        ? (
                          <a
                            href={`/participants/${row.participantId}`}
                            class="font-medium text-brand-700 hover:underline"
                          >
                            {row.participantCode}
                          </a>
                        )
                        : "—"}
                    </td>
                    {props.canOperate && (
                      <td class="py-2">
                        <SessionActions
                          row={row}
                          bookable={props.bookable}
                          canManage={props.canManage}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      {props.canOperate && props.bookable.length > 0 && (
        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-gray-900">
            Send a self-booking link
          </h2>
          <p class="text-sm text-gray-500">
            {openSlots.length} open slot{openSlots.length === 1 ? "" : "s"}{" "}
            available. Participants pick a slot themselves via a magic link.
          </p>
          <div class="flex flex-wrap gap-2">
            {props.bookable.map((e) => (
              <a
                key={e.id}
                href={`/enrollments/${e.id}/booking-link`}
                class="rounded-card border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50"
              >
                {e.code} — booking link →
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SessionActions(props: {
  row: SessionRow;
  bookable: { id: string; code: string }[];
  canManage: boolean;
}) {
  const { session } = props.row;
  const transitions = allowedSessionTransitions(session.status);
  const sid = session.id;

  return (
    <span class="inline-flex flex-wrap items-center gap-1.5">
      {session.status === "open" && props.bookable.length > 0 && (
        <form
          method="post"
          action={`/sessions/${sid}/book`}
          class="inline-flex gap-1"
        >
          <select
            name="enrollmentId"
            required
            class="rounded-card border border-gray-300 px-1.5 py-1 text-xs"
          >
            {props.bookable.map((e) => (
              <option key={e.id} value={e.id}>{e.code}</option>
            ))}
          </select>
          <button
            type="submit"
            class="rounded-card border border-brand-600 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50"
          >
            Book
          </button>
        </form>
      )}
      {transitions.includes("completed") && (
        <form method="post" action={`/sessions/${sid}/outcome`} class="inline">
          <input type="hidden" name="status" value="completed" />
          <button
            type="submit"
            class="rounded-card border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
          >
            Completed
          </button>
        </form>
      )}
      {transitions.includes("no_show") && (
        <form method="post" action={`/sessions/${sid}/outcome`} class="inline">
          <input type="hidden" name="status" value="no_show" />
          <button
            type="submit"
            class="rounded-card border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
          >
            No-show
          </button>
        </form>
      )}
      {session.status === "booked" && (
        <form
          method="post"
          action={`/sessions/${sid}/unbook`}
          class="inline"
          data-confirm={`Free ${
            props.row.participantCode ?? "this"
          } slot back to open?`}
        >
          <button
            type="submit"
            class="rounded-card border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
          >
            Unbook
          </button>
        </form>
      )}
      {props.canManage &&
        !["completed", "no_show", "cancelled"].includes(session.status) && (
        <form
          method="post"
          action={`/sessions/${sid}/cancel`}
          class="inline"
          data-confirm="Cancel this session slot?"
        >
          <button
            type="submit"
            class="rounded-card border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
          >
            Cancel
          </button>
        </form>
      )}
    </span>
  );
}
