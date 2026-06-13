// Screener eligibility rules (spec §3.4): declarative constraints over a
// simple form's answers that auto-set Enrollment status. Pure logic, like
// forms.ts. All rules are ANDed; deliberately no branching or boolean
// composition — that's the same scope cut as the form builder.
import { z } from "zod";
import type { Answers, FormItem } from "./forms.ts";
import { FormError } from "./forms.ts";

export const EligibilityRuleSchema = z.object({
  /** Key of the form item the rule constrains. */
  item: z.string(),
  /** Numeric bounds (number/likert items), inclusive. */
  min: z.number().nullish(),
  max: z.number().nullish(),
  /** Accepted options (choice items): answer must be one of these
   * (single choice) or include at least one (multi choice). */
  anyOf: z.array(z.string()).nullish(),
});

export type EligibilityRule = z.infer<typeof EligibilityRuleSchema>;

/** Validates rules against the pinned form items they reference. */
export function parseEligibility(
  input: unknown,
  items: FormItem[],
): EligibilityRule[] {
  const result = z.array(EligibilityRuleSchema).safeParse(input ?? []);
  if (!result.success) {
    throw new FormError(
      `Invalid eligibility rule: ${result.error.issues[0].message}`,
    );
  }
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const rule of result.data) {
    const item = byKey.get(rule.item);
    if (!item) {
      throw new FormError(
        `Eligibility rule references unknown item "${rule.item}".`,
      );
    }
    const numeric = item.type === "number" || item.type === "likert";
    const choice = item.type === "single_choice" ||
      item.type === "multi_choice";
    if ((rule.min != null || rule.max != null) && !numeric) {
      throw new FormError(
        `Eligibility bounds on "${rule.item}" need a number/likert item.`,
      );
    }
    if (rule.min != null && rule.max != null && rule.min > rule.max) {
      throw new FormError(`Eligibility bounds on "${rule.item}" are inverted.`);
    }
    if (rule.anyOf != null) {
      if (!choice) {
        throw new FormError(
          `Eligibility options on "${rule.item}" need a choice item.`,
        );
      }
      const unknown = rule.anyOf.find((o) => !item.options.includes(o));
      if (unknown !== undefined) {
        throw new FormError(
          `Eligibility rule on "${rule.item}" lists unknown option "${unknown}".`,
        );
      }
    }
    if (rule.min == null && rule.max == null && rule.anyOf == null) {
      throw new FormError(`Eligibility rule on "${rule.item}" is empty.`);
    }
  }
  return result.data;
}

/**
 * True when every rule passes. An unanswered constrained item fails the
 * rule — eligibility must be established, not assumed.
 */
export function evaluateEligibility(
  rules: EligibilityRule[],
  answers: Answers,
): boolean {
  for (const rule of rules) {
    const answer = answers[rule.item];
    if (rule.min != null || rule.max != null) {
      if (typeof answer !== "number") return false;
      if (rule.min != null && answer < rule.min) return false;
      if (rule.max != null && answer > rule.max) return false;
    }
    if (rule.anyOf != null && rule.anyOf.length > 0) {
      if (Array.isArray(answer)) {
        if (!answer.some((v) => rule.anyOf!.includes(v))) return false;
      } else if (typeof answer === "string") {
        if (!rule.anyOf.includes(answer)) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}
