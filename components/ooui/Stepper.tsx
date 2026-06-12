// Lifecycle progress stepper (spec §2.2 #5): state as a visible object
// property. Steps before the current one render as completed.
import { statusView } from "../../lib/ooui/status.ts";

export function Stepper(props: { steps: readonly string[]; current: string }) {
  const currentIdx = props.steps.indexOf(props.current);
  return (
    <ol class="flex flex-wrap items-center gap-1 text-xs">
      {props.steps.map((step, i) => {
        const state = currentIdx === -1
          ? "off"
          : i < currentIdx
          ? "done"
          : i === currentIdx
          ? "current"
          : "todo";
        return (
          <li
            key={step}
            class="flex items-center gap-1"
            data-step-state={state}
          >
            {i > 0 && <span class="text-gray-300">→</span>}
            <span
              class={`rounded-full px-2 py-0.5 font-medium ${
                state === "current"
                  ? "bg-brand-600 text-white"
                  : state === "done"
                  ? "bg-brand-50 text-brand-700"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {state === "done" ? "✓ " : ""}
              {statusView(step).label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
