// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import { FormError, type FormItem, parseItems } from "./forms.ts";
import { evaluateEligibility, parseEligibility } from "./eligibility.ts";

const ITEMS: FormItem[] = parseItems([
  { key: "age", prompt: "Age", type: "number", required: true },
  {
    key: "device",
    prompt: "Device",
    type: "single_choice",
    options: ["phone", "laptop"],
  },
  {
    key: "apps",
    prompt: "Apps",
    type: "multi_choice",
    options: ["maps", "transit", "rideshare"],
  },
  { key: "note", prompt: "Note", type: "short_text" },
]);

Deno.test("parseEligibility: cross-checks rules against items", () => {
  const rules = parseEligibility(
    [
      { item: "age", min: 21, max: 65 },
      { item: "device", anyOf: ["phone"] },
    ],
    ITEMS,
  );
  assert.equal(rules.length, 2);

  assert.throws(
    () => parseEligibility([{ item: "nope", min: 1 }], ITEMS),
    /unknown item/,
  );
  assert.throws(
    () => parseEligibility([{ item: "note", min: 1 }], ITEMS),
    /number\/likert/,
  );
  assert.throws(
    () => parseEligibility([{ item: "age", anyOf: ["x"] }], ITEMS),
    /choice item/,
  );
  assert.throws(
    () => parseEligibility([{ item: "device", anyOf: ["toaster"] }], ITEMS),
    /unknown option/,
  );
  assert.throws(
    () => parseEligibility([{ item: "age", min: 65, max: 21 }], ITEMS),
    /inverted/,
  );
  assert.throws(() => parseEligibility([{ item: "age" }], ITEMS), FormError);
});

Deno.test("evaluateEligibility: ANDed bounds and option membership", () => {
  const rules = parseEligibility(
    [
      { item: "age", min: 21, max: 65 },
      { item: "device", anyOf: ["phone"] },
      { item: "apps", anyOf: ["maps", "transit"] },
    ],
    ITEMS,
  );

  assert.equal(
    evaluateEligibility(rules, {
      age: 30,
      device: "phone",
      apps: ["rideshare", "maps"],
    }),
    true,
  );
  // One failing rule fails the whole screen.
  assert.equal(
    evaluateEligibility(rules, { age: 18, device: "phone", apps: ["maps"] }),
    false,
  );
  assert.equal(
    evaluateEligibility(rules, { age: 30, device: "laptop", apps: ["maps"] }),
    false,
  );
  // Multi-choice: needs at least one accepted option.
  assert.equal(
    evaluateEligibility(rules, {
      age: 30,
      device: "phone",
      apps: ["rideshare"],
    }),
    false,
  );
  // Unanswered constrained item fails (eligibility must be established).
  assert.equal(
    evaluateEligibility(rules, { device: "phone", apps: ["maps"] }),
    false,
  );
  // No rules → everyone is eligible.
  assert.equal(evaluateEligibility([], {}), true);
});
