// Pure-logic tests — no stack required (the db-backed aggregation is
// covered by funnel_db_test.ts, which needs the local stack).
import assert from "node:assert/strict";
import { funnelStages, perConditionTarget } from "./funnel.ts";

Deno.test("funnelStages: cumulative at-or-past counts from current statuses", () => {
  const stages = funnelStages(
    {
      screened: 4, // screened but not (yet) eligible
      eligible: 3,
      consented: 2,
      active: 1,
      completed: 2,
      withdrawn: 1, // counts as screened only — history is not replayed
      excluded: 1,
    },
    50,
  );
  assert.deepEqual(
    stages.map((s) => [s.id, s.count]),
    [
      ["viewed", 50],
      ["screened", 14],
      ["eligible", 8],
      ["consented", 5],
      ["completed", 2],
    ],
  );
});

Deno.test("funnelStages: no screener → no viewed stage; empty is all-zero", () => {
  const noViews = funnelStages({}, null);
  assert.equal(noViews[0].id, "screened");
  assert.ok(noViews.every((s) => s.count === 0));
  assert.equal(funnelStages({}, 0)[0].id, "viewed");
});

Deno.test("perConditionTarget: even split, rounded up; null without targets", () => {
  assert.equal(perConditionTarget(30, 2), 15);
  assert.equal(perConditionTarget(31, 2), 16); // ceil — never under-recruit
  assert.equal(perConditionTarget(null, 2), null);
  assert.equal(perConditionTarget(30, 0), null);
});
