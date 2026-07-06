// Pure tests for scale-score derivation — no DB.
import assert from "node:assert/strict";
import { applyScaleScores } from "./scale_scores.ts";
import type { FormItem, ScoringRule } from "../objects/forms.ts";

const ITEMS: FormItem[] = [
  {
    key: "q1",
    type: "likert",
    prompt: "Q1",
    min: 1,
    max: 5,
    minLabel: "",
    maxLabel: "",
    required: true,
  },
  {
    key: "q2",
    type: "likert",
    prompt: "Q2",
    min: 1,
    max: 5,
    minLabel: "",
    maxLabel: "",
    required: true,
  },
];

const RULES: ScoringRule[] = [
  {
    key: "wellbeing",
    name: "Wellbeing",
    aggregate: "mean",
    items: ["q1", "q2"],
    reverse: ["q2"],
  },
];

Deno.test("applyScaleScores: appends scale_* columns; partial rows skipped", () => {
  const rows = applyScaleScores(
    [
      { q1: 4, q2: 2, note: "hi" }, // q2 reversed: 1+5-2=4 → mean 4
      { q1: 5 }, // incomplete → no scale column
      { other: 1 },
    ],
    [{ items: ITEMS, scoring: RULES }],
  );
  assert.equal(rows[0].scale_wellbeing, 4);
  assert.equal(rows[0].note, "hi"); // original data untouched
  assert.ok(!("scale_wellbeing" in rows[1]));
  assert.ok(!("scale_wellbeing" in rows[2]));
});

Deno.test("applyScaleScores: no forms is identity", () => {
  const rows = [{ a: 1 }];
  assert.deepEqual(applyScaleScores(rows, []), rows);
});
