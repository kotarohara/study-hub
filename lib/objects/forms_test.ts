// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  FormError,
  type FormItem,
  parseItems,
  parseScoring,
  scoreResponse,
  validateResponse,
} from "./forms.ts";

const ITEMS: FormItem[] = parseItems([
  {
    key: "age",
    prompt: "Your age",
    type: "number",
    required: true,
    min: 18,
    max: 99,
  },
  {
    key: "device",
    prompt: "Primary device",
    type: "single_choice",
    required: true,
    options: ["phone", "laptop", "tablet"],
  },
  {
    key: "apps",
    prompt: "Apps you use",
    type: "multi_choice",
    options: ["maps", "transit", "rideshare"],
  },
  {
    key: "sat1",
    prompt: "I find maps easy to use",
    type: "likert",
    min: 1,
    max: 5,
  },
  { key: "sat2", prompt: "Maps frustrate me", type: "likert", min: 1, max: 5 },
  { key: "comments", prompt: "Anything else?", type: "long_text" },
]);

Deno.test("parseItems: rejects malformed items with readable messages", () => {
  assert.throws(() => parseItems([]), FormError);
  assert.throws(
    () => parseItems([{ key: "Bad Key", prompt: "x", type: "short_text" }]),
    FormError,
  );
  assert.throws(
    () =>
      parseItems([
        { key: "a", prompt: "x", type: "short_text" },
        { key: "a", prompt: "y", type: "short_text" },
      ]),
    /unique/,
  );
  assert.throws(
    () =>
      parseItems([{
        key: "c",
        prompt: "x",
        type: "single_choice",
        options: ["only"],
      }]),
    FormError,
  );
  assert.throws(
    () =>
      parseItems([{ key: "l", prompt: "x", type: "likert", min: 5, max: 1 }]),
    FormError,
  );
});

Deno.test("parseScoring: cross-checks rules against items", () => {
  const ok = parseScoring(
    [{
      key: "sat",
      name: "Satisfaction",
      aggregate: "mean",
      items: ["sat1", "sat2"],
      reverse: ["sat2"],
    }],
    ITEMS,
  );
  assert.equal(ok[0].reverse.length, 1);

  // Unknown item key.
  assert.throws(
    () =>
      parseScoring(
        [{ key: "s", name: "S", aggregate: "sum", items: ["nope"] }],
        ITEMS,
      ),
    /unknown item/,
  );
  // Non-numeric item in a scale.
  assert.throws(
    () =>
      parseScoring([{
        key: "s",
        name: "S",
        aggregate: "sum",
        items: ["device"],
      }], ITEMS),
    /not a numeric item/,
  );
  // Reverse key outside the rule's items, and reverse on non-likert.
  assert.throws(
    () =>
      parseScoring(
        [{
          key: "s",
          name: "S",
          aggregate: "sum",
          items: ["sat1"],
          reverse: ["sat2"],
        }],
        ITEMS,
      ),
    /not in its items/,
  );
  assert.throws(
    () =>
      parseScoring(
        [{
          key: "s",
          name: "S",
          aggregate: "sum",
          items: ["age"],
          reverse: ["age"],
        }],
        ITEMS,
      ),
    /reverse-score likert/,
  );
});

Deno.test("validateResponse: required, ranges and option membership", () => {
  const bad = validateResponse(ITEMS, {
    age: "seventeen",
    device: "toaster",
    apps: ["maps", "fax"],
    sat1: "9",
  });
  assert.equal(bad.errors.age, "Enter a number.");
  assert.match(bad.errors.device, /listed options/);
  assert.match(bad.errors.apps, /listed options/);
  assert.match(bad.errors.sat1, /scale points/);

  // Missing required vs missing optional.
  const missing = validateResponse(ITEMS, {});
  assert.ok(missing.errors.age);
  assert.ok(missing.errors.device);
  assert.equal(missing.errors.comments, undefined);

  const ok = validateResponse(ITEMS, {
    age: "25",
    device: "phone",
    apps: ["maps", "transit"],
    sat1: "4",
    sat2: "2",
    comments: "  trimmed  ",
  });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.answers.age, 25);
  assert.deepEqual(ok.answers.apps, ["maps", "transit"]);
  assert.equal(ok.answers.comments, "trimmed");

  // Out-of-range number.
  assert.match(
    validateResponse(ITEMS, { age: "12" }).errors.age,
    /allowed range/,
  );
});

Deno.test("scoreResponse: sum, mean, reverse scoring, incomplete → null", () => {
  const rules = parseScoring(
    [
      {
        key: "sat_mean",
        name: "Satisfaction",
        aggregate: "mean",
        items: ["sat1", "sat2"],
        reverse: ["sat2"],
      },
      {
        key: "sat_sum",
        name: "Sum",
        aggregate: "sum",
        items: ["sat1", "sat2"],
      },
    ],
    ITEMS,
  );
  const { answers } = validateResponse(ITEMS, {
    age: "25",
    device: "phone",
    sat1: "4",
    sat2: "2",
  });
  const scores = scoreResponse(ITEMS, rules, answers);
  // sat2 reversed on a 1–5 scale: 1 + 5 − 2 = 4 → mean of (4, 4).
  assert.equal(scores.sat_mean, 4);
  assert.equal(scores.sat_sum, 6);

  // Unanswered scale item → null, not a partial score.
  const partial = scoreResponse(
    ITEMS,
    rules,
    validateResponse(ITEMS, { age: "25", device: "phone", sat1: "4" }).answers,
  );
  assert.equal(partial.sat_mean, null);
});
