// Project roll-up calendar (spec §3.7): milestones by due date in a
// month grid. Server-rendered; month navigation via query params.
import {
  addMonths,
  monthGrid,
  monthParam,
  type MonthRef,
} from "../../lib/ooui/calendar.ts";
import { StatusBadge } from "./StatusBadge.tsx";

export interface CalendarEntry {
  date: string; // YYYY-MM-DD
  label: string;
  href: string;
  status: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function MonthCalendar(props: {
  month: MonthRef;
  baseHref: string;
  entries: CalendarEntry[];
  today?: string;
}) {
  const byDate = new Map<string, CalendarEntry[]>();
  for (const entry of props.entries) {
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  }
  const weeks = monthGrid(props.month);
  const nav = (delta: number) =>
    `${props.baseHref}?tab=timeline&month=${
      monthParam(addMonths(props.month, delta))
    }`;

  return (
    <section
      class="rounded-card border border-gray-200 bg-white p-3"
      data-month={monthParam(props.month)}
    >
      <div class="mb-2 flex items-center justify-between">
        <a href={nav(-1)} class="text-sm text-brand-700 hover:underline">
          ← previous
        </a>
        <h3 class="text-sm font-semibold text-gray-900">
          {MONTH_NAMES[props.month.month - 1]} {props.month.year}
        </h3>
        <a href={nav(1)} class="text-sm text-brand-700 hover:underline">
          next →
        </a>
      </div>
      <table class="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} class="border border-gray-100 p-1 text-gray-500">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((date, di) => (
                <td
                  key={di}
                  class={`h-16 border border-gray-100 p-1 align-top ${
                    date === props.today ? "bg-brand-50" : ""
                  }`}
                >
                  {date && (
                    <>
                      <span class="text-gray-400">{Number(date.slice(8))}</span>
                      {(byDate.get(date) ?? []).map((entry, i) => (
                        <a
                          key={i}
                          href={entry.href}
                          class="mt-0.5 block truncate rounded bg-gray-50 px-1 text-gray-800 hover:bg-brand-50"
                          title={entry.label}
                        >
                          <StatusBadge status={entry.status} /> {entry.label}
                        </a>
                      ))}
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
