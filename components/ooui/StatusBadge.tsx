import { type StatusTone, statusView } from "../../lib/ooui/status.ts";

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-gray-100 text-gray-700 border-gray-200",
  info: "bg-blue-50 text-blue-800 border-blue-200",
  success: "bg-green-50 text-green-800 border-green-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
  danger: "bg-red-50 text-red-800 border-red-200",
  // Pilot is deliberately loud and never restyled (spec §3.3).
  pilot: "bg-pilot-bg text-pilot-text border-pilot-border font-bold uppercase",
};

export function StatusBadge(props: { status: string }) {
  const { label, tone } = statusView(props.status);
  return (
    <span
      class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        TONE_CLASSES[tone]
      }`}
      data-status={props.status}
    >
      {label}
    </span>
  );
}
