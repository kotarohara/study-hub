import type { ResolvedAction } from "../../lib/ooui/actions.ts";

const TONE_CLASSES = {
  default: "border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
  primary: "border-brand-600 bg-brand-600 text-white hover:bg-brand-700",
  danger: "border-red-300 bg-white text-red-700 hover:bg-red-50",
};

const DISABLED_CLASSES = "border-gray-200 bg-gray-50 text-gray-400";

function classes(action: ResolvedAction): string {
  return `rounded-card border px-3 py-1.5 text-sm font-medium ${
    action.enabled ? TONE_CLASSES[action.tone ?? "default"] : DISABLED_CLASSES
  }`;
}

/** Uniform action rendering for detail headers and collection toolbars. */
export function ActionBar(props: { actions: ResolvedAction[] }) {
  if (props.actions.length === 0) return null;
  return (
    <div class="flex flex-wrap items-center gap-2">
      {props.actions.map((action) =>
        !action.enabled
          ? (
            <button
              type="button"
              disabled
              class={classes(action)}
              title={action.reason}
            >
              {action.label}
            </button>
          )
          : action.method === "get"
          ? (
            <a href={action.href} class={classes(action)}>
              {action.label}
            </a>
          )
          : (
            <form
              method="post"
              action={action.href}
              class="inline"
              data-confirm={action.confirm}
            >
              <button type="submit" class={classes(action)}>
                {action.label}
              </button>
            </form>
          )
      )}
    </div>
  );
}
