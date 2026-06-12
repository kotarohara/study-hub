// Minimal layout for participant-facing pages (p/[token]/...): no lab
// navigation, no member context — just a centered card.
import type { ComponentChildren } from "preact";

export function PublicLayout(props: {
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div class="min-h-screen bg-gray-50 px-4 py-10">
      <main class="mx-auto max-w-xl">
        <h1 class="mb-6 text-2xl font-bold text-gray-900">{props.title}</h1>
        <div class="rounded-card border border-gray-200 bg-white p-6">
          {props.children}
        </div>
        <p class="mt-6 text-center text-xs text-gray-400">StudyHub</p>
      </main>
    </div>
  );
}
