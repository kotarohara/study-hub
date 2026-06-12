// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  barGeometry,
  type GanttItem,
  ganttRange,
  monthTicks,
  shiftIsoDate,
} from "./gantt.ts";

function item(over: Partial<GanttItem>): GanttItem {
  return {
    id: "x",
    title: "t",
    start: null,
    due: null,
    status: "pending",
    blocked: false,
    ...over,
  };
}

const TODAY = new Date("2026-06-12T10:00:00Z");

Deno.test("ganttRange: month-padded, includes today, null when undated", () => {
  assert.equal(ganttRange([item({})], TODAY), null);

  const range = ganttRange(
    [item({ start: "2026-07-10", due: "2026-08-05" })],
    TODAY,
  )!;
  // June (today) through August, padded to month boundaries.
  assert.equal(range.start.toISOString().slice(0, 10), "2026-06-01");
  assert.equal(range.days, 30 + 31 + 31);
});

Deno.test("barGeometry: spans, single-date sliver, minimum width", () => {
  const range = ganttRange(
    [item({ start: "2026-06-01", due: "2026-06-30" })],
    TODAY,
  )!;
  assert.equal(range.days, 30);

  const full = barGeometry(
    item({ start: "2026-06-01", due: "2026-06-30" }),
    range,
  )!;
  assert.equal(full.leftPct, 0);
  assert.equal(full.widthPct, 100);

  const single = barGeometry(item({ due: "2026-06-16" }), range)!;
  assert.ok(Math.abs(single.leftPct - 50) < 0.01);
  assert.ok(single.widthPct >= 0.75);

  assert.equal(barGeometry(item({}), range), null);
});

Deno.test("monthTicks: one per month at the right offsets", () => {
  const range = ganttRange(
    [item({ start: "2026-06-03", due: "2026-08-20" })],
    TODAY,
  )!;
  const ticks = monthTicks(range);
  assert.deepEqual(ticks.map((t) => t.label), [
    "Jun 2026",
    "Jul 2026",
    "Aug 2026",
  ]);
  assert.equal(ticks[0].leftPct, 0);
  assert.ok(Math.abs(ticks[1].leftPct - (30 / range.days) * 100) < 0.01);
});

Deno.test("shiftIsoDate: day arithmetic across month boundaries", () => {
  assert.equal(shiftIsoDate("2026-06-28", 5), "2026-07-03");
  assert.equal(shiftIsoDate("2026-07-03", -5), "2026-06-28");
  assert.equal(shiftIsoDate("2026-06-12", 0), "2026-06-12");
});
