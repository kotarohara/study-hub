// Global navigation lists object collections, not features (spec §2.2 #1).
// Items flip to enabled as their phases land.

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: string;
  enabled: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/", icon: "⌂", enabled: true },
  {
    id: "projects",
    label: "Projects",
    href: "/projects",
    icon: "▣",
    enabled: true,
  },
  {
    id: "studies",
    label: "Studies",
    href: "/studies",
    icon: "⚗",
    enabled: true,
  },
  {
    id: "participants",
    label: "Participants",
    href: "/participants",
    icon: "◉",
    enabled: true,
  },
  {
    id: "instruments",
    label: "Instruments",
    href: "/instruments",
    icon: "☰",
    enabled: true,
  },
  {
    id: "documents",
    label: "Documents",
    href: "/documents",
    icon: "▤",
    enabled: true,
  },
  {
    id: "payments",
    label: "Payments",
    href: "/payments",
    icon: "◈",
    enabled: true,
  },
  {
    id: "members",
    label: "Members",
    href: "/members",
    icon: "♟",
    enabled: true,
  },
];

export function isActive(item: NavItem, pathname: string): boolean {
  return item.href === "/"
    ? pathname === "/"
    : pathname === item.href || pathname.startsWith(item.href + "/");
}
