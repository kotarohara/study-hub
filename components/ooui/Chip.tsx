// Inline/compact view (spec §2.2 #2): how an object appears inside another
// object's detail view. Clickable; drag-and-drop comes with the islands
// that need it.
import { StatusBadge } from "./StatusBadge.tsx";

export function Chip(props: {
  href: string;
  icon?: string;
  label: string;
  sublabel?: string;
  status?: string;
}) {
  return (
    <a
      href={props.href}
      class="inline-flex items-center gap-2 rounded-card border border-gray-200 bg-white px-3 py-1.5 text-sm hover:border-brand-600 hover:bg-brand-50"
    >
      {props.icon && <span aria-hidden="true">{props.icon}</span>}
      <span class="font-medium text-gray-900">{props.label}</span>
      {props.sublabel && <span class="text-gray-500">{props.sublabel}</span>}
      {props.status && <StatusBadge status={props.status} />}
    </a>
  );
}
