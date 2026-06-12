// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  addMonths,
  monthGrid,
  monthParam,
  parseMonthParam,
} from "./calendar.ts";

Deno.test("parseMonthParam: valid, invalid, fallback", () => {
  const fallback = new Date("2026-06-12T00:00:00Z");
  assert.deepEqual(parseMonthParam("2026-09", fallback), {
    year: 2026,
    month: 9,
  });
  assert.deepEqual(parseMonthParam("2026-13", fallback), {
    year: 2026,
    month: 6,
  });
  assert.deepEqual(parseMonthParam("junk", fallback), { year: 2026, month: 6 });
  assert.deepEqual(parseMonthParam(null, fallback), { year: 2026, month: 6 });
});

Deno.test("addMonths: wraps across year boundaries", () => {
  assert.deepEqual(addMonths({ year: 2026, month: 12 }, 1), {
    year: 2027,
    month: 1,
  });
  assert.deepEqual(addMonths({ year: 2026, month: 1 }, -1), {
    year: 2025,
    month: 12,
  });
  assert.equal(monthParam(addMonths({ year: 2026, month: 6 }, 0)), "2026-06");
});

Deno.test("monthGrid: Monday-based weeks with null padding", () => {
  // June 2026 starts on a Monday and has 30 days.
  const june = monthGrid({ year: 2026, month: 6 });
  assert.equal(june[0][0], "2026-06-01");
  assert.equal(june.at(-1)![1], "2026-06-30"); // 30th is a Tuesday
  assert.equal(june.at(-1)![2], null); // padded
  assert.ok(june.every((w) => w.length === 7));

  // Feb 2026 starts on a Sunday → six leading nulls.
  const feb = monthGrid({ year: 2026, month: 2 });
  assert.deepEqual(feb[0].slice(0, 6), [null, null, null, null, null, null]);
  assert.equal(feb[0][6], "2026-02-01");
});
