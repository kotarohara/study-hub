// Simple-form model (spec §3.4, §4 kept-feature 4): item types without
// branching, plus scale scoring rules ("scale auto-scoring from instrument
// rules", §3.6). Pure logic — shared by the builder island, the server
// validation of public submissions (Phase 2.4) and EDA scoring (Phase 4).
import { z } from "zod";

export class FormError extends Error {}

export const ITEM_TYPES = [
  "short_text",
  "long_text",
  "number",
  "single_choice",
  "multi_choice",
  "likert",
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

/** Machine key items/rules are referenced by (answers, scoring, exports). */
const Key = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "keys are short_snake_case");

const base = {
  key: Key,
  prompt: z.string().trim().min(1, "prompt is required"),
  required: z.boolean().default(false),
};

const Options = z
  .array(z.string().trim().min(1))
  .min(2, "choice items need at least 2 options")
  .refine((opts) => new Set(opts).size === opts.length, {
    message: "options must be unique",
  });

export const FormItemSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("short_text") }),
  z.object({ ...base, type: z.literal("long_text") }),
  z.object({
    ...base,
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
  }).refine(
    (i) => i.min === undefined || i.max === undefined || i.min < i.max,
    {
      message: "min must be below max",
    },
  ),
  z.object({ ...base, type: z.literal("single_choice"), options: Options }),
  z.object({ ...base, type: z.literal("multi_choice"), options: Options }),
  z.object({
    ...base,
    type: z.literal("likert"),
    min: z.number().int().default(1),
    max: z.number().int(),
    minLabel: z.string().default(""),
    maxLabel: z.string().default(""),
  }).refine((i) => i.max > i.min && i.max - i.min <= 10, {
    message: "likert needs min < max with at most 11 points",
  }),
]);

export type FormItem = z.infer<typeof FormItemSchema>;

export const ScoringRuleSchema = z.object({
  key: Key,
  name: z.string().trim().min(1, "rule name is required"),
  aggregate: z.enum(["sum", "mean"]),
  /** Keys of the numeric items (number/likert) this scale aggregates. */
  items: z.array(Key).min(1, "a rule needs at least one item"),
  /** Likert item keys scored as (min + max) − answer. */
  reverse: z.array(Key).default([]),
});

export type ScoringRule = z.infer<typeof ScoringRuleSchema>;

function fail(prefix: string, error: z.ZodError): never {
  const issue = error.issues[0];
  const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  throw new FormError(`${prefix}${path}: ${issue.message}`);
}

/** Validates builder output: well-formed items with unique keys. */
export function parseItems(input: unknown): FormItem[] {
  const result = z.array(FormItemSchema).min(
    1,
    "a form needs at least one item",
  )
    .safeParse(input);
  if (!result.success) fail("Invalid form item", result.error);
  const keys = result.data.map((i) => i.key);
  if (new Set(keys).size !== keys.length) {
    throw new FormError("Item keys must be unique.");
  }
  return result.data;
}

function isNumericItem(item: FormItem): boolean {
  return item.type === "number" || item.type === "likert";
}

/** Validates scoring rules against the items they reference. */
export function parseScoring(input: unknown, items: FormItem[]): ScoringRule[] {
  const result = z.array(ScoringRuleSchema).safeParse(input ?? []);
  if (!result.success) fail("Invalid scoring rule", result.error);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const ruleKeys = result.data.map((r) => r.key);
  if (new Set(ruleKeys).size !== ruleKeys.length) {
    throw new FormError("Scoring rule keys must be unique.");
  }
  for (const rule of result.data) {
    for (const key of rule.items) {
      const item = byKey.get(key);
      if (!item) {
        throw new FormError(
          `Scoring rule "${rule.name}" references unknown item "${key}".`,
        );
      }
      if (!isNumericItem(item)) {
        throw new FormError(
          `Scoring rule "${rule.name}" includes "${key}", which is not a numeric item.`,
        );
      }
    }
    for (const key of rule.reverse) {
      if (!rule.items.includes(key)) {
        throw new FormError(
          `Scoring rule "${rule.name}" reverse-scores "${key}" which is not in its items.`,
        );
      }
      if (byKey.get(key)?.type !== "likert") {
        throw new FormError(
          `Scoring rule "${rule.name}" can only reverse-score likert items ("${key}").`,
        );
      }
    }
  }
  return result.data;
}

/** Raw submission values as they arrive from FormData. */
export type RawAnswers = Record<string, string | string[]>;
/** Typed answers after validation. */
export type Answers = Record<string, string | number | string[]>;

export interface ResponseValidation {
  answers: Answers;
  /** Item key → human-readable problem; empty means valid. */
  errors: Record<string, string>;
}

/** Server-side validation of a submission against the form definition. */
export function validateResponse(
  items: FormItem[],
  raw: RawAnswers,
): ResponseValidation {
  const answers: Answers = {};
  const errors: Record<string, string> = {};

  for (const item of items) {
    const value = raw[item.key];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const text = Array.isArray(value) ? "" : (value ?? "").trim();

    const missing = item.type === "multi_choice"
      ? values.length === 0
      : text === "";
    if (missing) {
      if (item.required) errors[item.key] = "This question is required.";
      continue;
    }

    switch (item.type) {
      case "short_text":
      case "long_text":
        answers[item.key] = text;
        break;
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n)) {
          errors[item.key] = "Enter a number.";
        } else if (
          (item.min !== undefined && n < item.min) ||
          (item.max !== undefined && n > item.max)
        ) {
          errors[item.key] = "Out of the allowed range.";
        } else {
          answers[item.key] = n;
        }
        break;
      }
      case "likert": {
        const n = Number(text);
        if (!Number.isInteger(n) || n < item.min || n > item.max) {
          errors[item.key] = "Pick one of the scale points.";
        } else {
          answers[item.key] = n;
        }
        break;
      }
      case "single_choice":
        if (!item.options.includes(text)) {
          errors[item.key] = "Pick one of the listed options.";
        } else {
          answers[item.key] = text;
        }
        break;
      case "multi_choice": {
        const invalid = values.find((v) => !item.options.includes(v));
        if (invalid !== undefined) {
          errors[item.key] = "Pick only listed options.";
        } else {
          answers[item.key] = values;
        }
        break;
      }
    }
  }
  return { answers, errors };
}

/**
 * Applies scoring rules to validated answers. A scale scores to null when
 * any of its items is unanswered — partial scales are misleading.
 */
export function scoreResponse(
  items: FormItem[],
  rules: ScoringRule[],
  answers: Answers,
): Record<string, number | null> {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const scores: Record<string, number | null> = {};
  for (const rule of rules) {
    const values: number[] = [];
    let complete = true;
    for (const key of rule.items) {
      const answer = answers[key];
      if (typeof answer !== "number") {
        complete = false;
        break;
      }
      const item = byKey.get(key);
      values.push(
        rule.reverse.includes(key) && item?.type === "likert"
          ? item.min + item.max - answer
          : answer,
      );
    }
    if (!complete) {
      scores[rule.key] = null;
      continue;
    }
    const sum = values.reduce((a, b) => a + b, 0);
    scores[rule.key] = rule.aggregate === "sum" ? sum : sum / values.length;
  }
  return scores;
}
