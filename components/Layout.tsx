// App shell: sidebar of object collections (OOUI: objects, not features)
// and a top bar with the signed-in member.
import type { ComponentChildren } from "preact";
import type { Member } from "../lib/db/schema.ts";
import { isActive, NAV_ITEMS } from "../lib/ooui/nav.ts";
import { StatusBadge } from "./ooui/StatusBadge.tsx";

export function Layout(props: {
  member: Member;
  pathname: string;
  title?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="flex min-h-screen bg-gray-50">
      <aside class="flex w-56 flex-col border-r border-gray-200 bg-white">
        <a href="/" class="px-4 py-4 text-lg font-bold text-brand-900">
          StudyHub
        </a>
        <nav class="flex flex-1 flex-col gap-0.5 px-2">
          {NAV_ITEMS.map((item) =>
            item.enabled
              ? (
                <a
                  href={item.href}
                  class={`flex items-center gap-2 rounded-card px-3 py-2 text-sm font-medium ${
                    isActive(item, props.pathname)
                      ? "bg-brand-50 text-brand-700"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </a>
              )
              : (
                <span
                  class="flex items-center gap-2 rounded-card px-3 py-2 text-sm text-gray-300"
                  title="Coming soon"
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </span>
              )
          )}
        </nav>
      </aside>

      <div class="flex flex-1 flex-col">
        <header class="flex items-center justify-end gap-3 border-b border-gray-200 bg-white px-6 py-3">
          <span class="text-sm text-gray-700">{props.member.name}</span>
          <StatusBadge status={props.member.role} />
          <form method="post" action="/logout">
            <button
              type="submit"
              class="rounded-card border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Sign out
            </button>
          </form>
        </header>
        <main class="flex-1 p-6">
          {props.title && (
            <h1 class="mb-4 text-2xl font-bold text-gray-900">{props.title}</h1>
          )}
          {props.children}
        </main>
      </div>
    </div>
  );
}
