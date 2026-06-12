// Pure geometry for the TimelineGantt island (spec §3.7): date ↔ percent
// mapping, month ticks, and bar placement. Kept island-free so it is
// unit-testable without a browser.

export interface GanttItem {
  id: string;
  title: string;
  /** ISO dates (YYYY-MM-DD) — islands need JSON-safe props. */
  start: string | null;
  due: string | null;
  status: string;
  blocked: boolean;
}

export interface GanttRange {
  /** First day shown (inclusive), UTC midnight. */
  start: Date;
  /** Number of days shown. */
  days: number;
}

const DAY_MS = 24 * 3600 * 1000;

function utcDate(iso: string): Date {
  return new Date(iso + "T00:00:00Z");
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfNextMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Padded range covering every dated item (and today); null if undated. */
export function ganttRange(
  items: GanttItem[],
  today = new Date(),
): GanttRange | null {
  const dates = items
    .flatMap((i) => [i.start, i.due])
    .filter((d): d is string => d !== null)
    .map(utcDate);
  if (dates.length === 0) return null;
  dates.push(
    new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    )),
  );
  const min = new Date(Math.min(...dates.map((d) => d.getTime())));
  const max = new Date(Math.max(...dates.map((d) => d.getTime())));
  const start = startOfMonth(min);
  const end = startOfNextMonth(max); // exclusive
  return {
    start,
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS),
  };
}

export function dayIndex(iso: string, range: GanttRange): number {
  return Math.round((utcDate(iso).getTime() - range.start.getTime()) / DAY_MS);
}

export interface BarGeometry {
  leftPct: number;
  widthPct: number;
}

/** Bar placement; single-date items render as a 1-day sliver. */
export function barGeometry(
  item: GanttItem,
  range: GanttRange,
): BarGeometry | null {
  const startIso = item.start ?? item.due;
  const dueIso = item.due ?? item.start;
  if (!startIso || !dueIso) return null;
  const from = dayIndex(startIso, range);
  const to = dayIndex(dueIso, range);
  const leftPct = (from / range.days) * 100;
  const widthPct = Math.max(((to - from + 1) / range.days) * 100, 0.75);
  return { leftPct, widthPct };
}

export interface MonthTick {
  leftPct: number;
  label: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function monthTicks(range: GanttRange): MonthTick[] {
  const ticks: MonthTick[] = [];
  let cursor = new Date(range.start);
  const endMs = range.start.getTime() + range.days * DAY_MS;
  while (cursor.getTime() < endMs) {
    const offsetDays = Math.round(
      (cursor.getTime() - range.start.getTime()) / DAY_MS,
    );
    ticks.push({
      leftPct: (offsetDays / range.days) * 100,
      label: `${MONTHS[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`,
    });
    cursor = startOfNextMonth(cursor);
  }
  return ticks;
}

/** Shifts an ISO date by whole days (used by drag-to-reschedule). */
export function shiftIsoDate(iso: string, deltaDays: number): string {
  return new Date(utcDate(iso).getTime() + deltaDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
