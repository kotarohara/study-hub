// Pseudonymous delivery log for the study Sessions tab (spec §3.8): the
// record of automated participant comms (booking confirmations, reminders).
// PII never appears here — recipient/subject/body stay encrypted in the
// messages table; this view shows only the participant code, template,
// channel, and delivery status.
import type { StudyMessageLogRow } from "../lib/objects/messaging.ts";
import { StatusBadge } from "./ooui/StatusBadge.tsx";

function fmt(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

const TEMPLATE_LABELS: Record<string, string> = {
  booking_confirmation: "Booking confirmation",
  session_reminder: "Session reminder",
};

export function MessageLog(props: { rows: StudyMessageLogRow[] }) {
  const { rows } = props;
  return (
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-gray-900">
        Message log ({rows.length})
      </h2>
      {rows.length === 0
        ? (
          <p class="text-sm text-gray-500">
            No automated messages sent yet. Booking confirmations and reminders
            appear here once participants are booked.
          </p>
        )
        : (
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th class="py-2 pr-4">When</th>
                <th class="py-2 pr-4">Participant</th>
                <th class="py-2 pr-4">Message</th>
                <th class="py-2 pr-4">Channel</th>
                <th class="py-2 pr-4">Status</th>
                <th class="py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} class="border-b border-gray-100">
                  <td class="py-2 pr-4">{fmt(row.createdAt)}</td>
                  <td class="py-2 pr-4 font-medium text-gray-800">
                    {row.participantCode}
                  </td>
                  <td class="py-2 pr-4">
                    {TEMPLATE_LABELS[row.templateKey] ?? row.templateKey}
                  </td>
                  <td class="py-2 pr-4">{row.channel}</td>
                  <td class="py-2 pr-4">
                    <StatusBadge status={row.status} />
                  </td>
                  <td class="py-2 text-xs text-gray-500">
                    {row.status === "sent" && row.sentAt
                      ? `sent ${fmt(row.sentAt)}`
                      : row.status === "failed"
                      ? `${row.attempts} attempt${
                        row.attempts === 1 ? "" : "s"
                      }${row.lastError ? ` — ${row.lastError}` : ""}`
                      : `queued`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  );
}
