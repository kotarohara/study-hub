// Pure tests — no DB, no network.
import assert from "node:assert/strict";
import {
  histogram,
  numericColumn,
  numericColumns,
  numericSummary,
  quantileSorted,
  summarizeByGroup,
} from "./stats.ts";

Deno.test("quantileSorted: interpolated (R type 7)", () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(quantileSorted(sorted, 0), 1);
  assert.equal(quantileSorted(sorted, 0.5), 2.5);
  assert.equal(quantileSorted(sorted, 0.25), 1.75);
  assert.equal(quantileSorted(sorted, 1), 4);
});

Deno.test("numericSummary: known values", () => {
  const s = numericSummary([2, 4, 4, 4, 5, 5, 7, 9])!;
  assert.equal(s.n, 8);
  assert.equal(s.mean, 5);
  assert.equal(s.min, 2);
  assert.equal(s.max, 9);
  assert.equal(s.median, 4.5);
  // Sample sd of this classic set is ~2.138.
  assert.ok(Math.abs(s.sd - 2.138) < 0.001);
  assert.equal(numericSummary([]), null);
  assert.equal(numericSummary([3])!.sd, 0);
});

Deno.test("histogram: fixed-width bins, max in last bin, constant column", () => {
  const bins = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 10], 5);
  assert.equal(bins.length, 5);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 10);
  assert.equal(bins[0].start, 0);
  assert.equal(bins[4].end, 10);
  assert.ok(bins[4].count >= 1); // the max value lands in the last bin

  const constant = histogram([5, 5, 5]);
  assert.deepEqual(constant, [{ start: 5, end: 5, count: 3 }]);
  assert.deepEqual(histogram([]), []);
});

Deno.test("summarizeByGroup: pools null groups, sorts names", () => {
  const groups = summarizeByGroup([
    { group: "b", value: 2 },
    { group: "a", value: 1 },
    { group: null, value: 9 },
    { group: "a", value: 3 },
  ]);
  assert.deepEqual(groups.map((g) => g.group), ["(none)", "a", "b"]);
  assert.equal(groups[1].summary.mean, 2);
  assert.equal(groups[0].summary.n, 1);
});

Deno.test("numericColumn/numericColumns: numbers only, missing tolerated", () => {
  const rows = [
    { mood: 4, device: "phone", score: 1 },
    { mood: 2, device: "laptop", score: "" },
    { mood: "", device: "phone", score: 3 },
    { free: "text" },
  ];
  assert.deepEqual(numericColumn(rows, "mood"), [4, 2]);
  assert.deepEqual(numericColumns(rows).sort(), ["mood", "score"]);
});
