// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  type AssignmentState,
  nextCondition,
  parseSequence,
  planAssignments,
  seededRandom,
} from "./assignment.ts";
import { StudyError } from "./studies.ts";

const A = { id: "a", name: "control", position: 1 };
const B = { id: "b", name: "treatment", position: 2 };
const C = { id: "c", name: "placebo", position: 3 };

function state(over: Partial<AssignmentState> = {}): AssignmentState {
  return {
    conditions: [A, B, C],
    counts: {},
    strategy: "random_balanced",
    sequence: "",
    assignedSoFar: 0,
    random: seededRandom(7),
    ...over,
  };
}

Deno.test("random_balanced: never lets group sizes differ by more than one", () => {
  const plan = planAssignments(state(), 31);
  const tally: Record<string, number> = {};
  for (const c of plan) tally[c.id] = (tally[c.id] ?? 0) + 1;
  const sizes = Object.values(tally);
  assert.equal(sizes.length, 3);
  assert.ok(
    Math.max(...sizes) - Math.min(...sizes) <= 1,
    JSON.stringify(tally),
  );
});

Deno.test("random_balanced: respects pre-existing counts", () => {
  // a already has 5; the next assignments must go to b/c until caught up.
  const plan = planAssignments(state({ counts: { a: 5 } }), 10);
  assert.ok(plan.slice(0, 10).every((c) => c.id !== "a"));
});

Deno.test("random_balanced: deterministic with a seeded RNG", () => {
  const p1 = planAssignments(state(), 12).map((c) => c.id);
  const p2 = planAssignments(state(), 12).map((c) => c.id);
  assert.deepEqual(p1, p2);
});

Deno.test("manual_sequence: cycles the sequence from the cursor", () => {
  const s = state({
    strategy: "manual_sequence",
    sequence: "control, treatment, treatment, control",
  });
  const plan = planAssignments(s, 6).map((c) => c.name);
  assert.deepEqual(plan, [
    "control",
    "treatment",
    "treatment",
    "control",
    "control",
    "treatment",
  ]);

  // Cursor offset: enrollment #3 (0-based) gets the 4th slot.
  const fourth = nextCondition({ ...s, assignedSoFar: 3 });
  assert.equal(fourth.name, "control");
});

Deno.test("manual_sequence: unknown names and empty sequences are rejected", () => {
  assert.throws(
    () =>
      nextCondition(state({ strategy: "manual_sequence", sequence: "ghost" })),
    StudyError,
  );
  assert.throws(
    () => nextCondition(state({ strategy: "manual_sequence", sequence: " " })),
    StudyError,
  );
});

Deno.test("parseSequence: trims, splits on commas/newlines, validates", () => {
  const parsed = parseSequence("control,\n treatment ,control", [A, B, C]);
  assert.deepEqual(parsed.map((c) => c.id), ["a", "b", "a"]);
  assert.throws(() => parseSequence("control, nope", [A, B]), StudyError);
});

Deno.test("no conditions: assignment is refused", () => {
  assert.throws(() => nextCondition(state({ conditions: [] })), StudyError);
});
