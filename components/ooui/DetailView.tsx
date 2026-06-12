// Detail view (spec §2.2 #2): identity header (icon, name, status badge),
// property panel, related-object tabs, and the action bar.
import type { ComponentChildren } from "preact";
import type { ResolvedAction } from "../../lib/ooui/actions.ts";
import { ActionBar } from "./ActionBar.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

export interface Tab {
  id: string;
  label: string;
}

export interface Property {
  label: string;
  value: ComponentChildren;
}

export function DetailView(props: {
  icon?: string;
  typeLabel: string;
  title: string;
  status?: string;
  properties: Property[];
  tabs: Tab[];
  activeTab: string;
  /** Tab links go to `${baseHref}?tab=<id>`. */
  baseHref: string;
  actions: ResolvedAction[];
  children: ComponentChildren;
}) {
  return (
    <article>
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex items-center gap-3">
          {props.icon && (
            <span class="text-3xl" aria-hidden="true">{props.icon}</span>
          )}
          <div>
            <p class="text-xs uppercase tracking-wide text-gray-500">
              {props.typeLabel}
            </p>
            <h1 class="flex items-center gap-3 text-2xl font-bold text-gray-900">
              {props.title}
              {props.status && <StatusBadge status={props.status} />}
            </h1>
          </div>
        </div>
        <ActionBar actions={props.actions} />
      </header>

      {props.properties.length > 0 && (
        <dl class="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 rounded-card border border-gray-200 bg-white p-4 text-sm md:grid-cols-4">
          {props.properties.map((prop) => (
            <div>
              <dt class="text-xs uppercase tracking-wide text-gray-500">
                {prop.label}
              </dt>
              <dd class="mt-0.5 text-gray-900">{prop.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <nav class="mt-6 flex gap-1 border-b border-gray-200">
        {props.tabs.map((tab) => (
          <a
            href={`${props.baseHref}?tab=${tab.id}`}
            class={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab.id === props.activeTab
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      <div class="py-4">{props.children}</div>
    </article>
  );
}
