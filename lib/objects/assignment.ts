// Condition assignment engine (spec §3.2): random or manually-defined
// counterbalanced order assignment of Enrollments to Conditions.
//
// Pure logic, deliberately storage-free: Enrollments arrive in Phase 2, and
// 2.5 wires this engine to real enrollment rows (each assignment event is
// audited there). Until then the per-study configuration (strategy +
// sequence) is set in the design editor and previewed there.
import type { Condition } from "../db/schema.ts";
import { StudyError } from "./studies.ts";

export type AssignmentStrategy = "random_balanced" | "manual_sequence";

export const ASSIGNMENT_STRATEGIES: AssignmentStrategy[] = [
  "random_balanced",
  "manual_sequence",
];

export interface AssignmentState {
  conditions: Pick<Condition, "id" | "name" | "position">[];
  /** Existing assignment counts per condition id (missing = 0). */
  counts: Record<string, number>;
  strategy: AssignmentStrategy;
  /** For manual_sequence: raw comma-separated condition names. */
  sequence: string;
  /** Total assignments already made (sequence cursor). */
  assignedSoFar: number;
  /** Injectable RNG in [0,1) — seeded in tests and previews. */
  random?: () => number;
}

/** Deterministic RNG (mulberry32) for previews and tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parses a manual sequence ("A, B, B, A") against the study's conditions.
 * Names must match exactly one existing condition.
 */
export function parseSequence(
  raw: string,
  conditions: AssignmentState["conditions"],
): Pick<Condition, "id" | "name" | "position">[] {
  const names = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new StudyError("The manual sequence is empty.");
  }
  const byName = new Map(conditions.map((c) => [c.name, c]));
  return names.map((name) => {
    const condition = byName.get(name);
    if (!condition) {
      throw new StudyError(
        `"${name}" in the sequence is not a condition of this study.`,
      );
    }
    return condition;
  });
}

/** Picks the condition for the next assignment. */
export function nextCondition(
  state: AssignmentState,
): Pick<Condition, "id" | "name" | "position"> {
  if (state.conditions.length === 0) {
    throw new StudyError("The study has no conditions to assign.");
  }

  if (state.strategy === "manual_sequence") {
    const sequence = parseSequence(state.sequence, state.conditions);
    return sequence[state.assignedSoFar % sequence.length];
  }

  // random_balanced: choose uniformly among the least-assigned conditions,
  // so group sizes never differ by more than one.
  const random = state.random ?? Math.random;
  const min = Math.min(
    ...state.conditions.map((c) => state.counts[c.id] ?? 0),
  );
  const candidates = state.conditions.filter(
    (c) => (state.counts[c.id] ?? 0) === min,
  );
  return candidates[Math.floor(random() * candidates.length)];
}

/** Simulates the next `n` assignments (used by the design-editor preview). */
export function planAssignments(
  state: AssignmentState,
  n: number,
): Pick<Condition, "id" | "name" | "position">[] {
  const counts = { ...state.counts };
  let assignedSoFar = state.assignedSoFar;
  const plan: Pick<Condition, "id" | "name" | "position">[] = [];
  for (let i = 0; i < n; i++) {
    const condition = nextCondition({
      ...state,
      counts,
      assignedSoFar,
    });
    plan.push(condition);
    counts[condition.id] = (counts[condition.id] ?? 0) + 1;
    assignedSoFar += 1;
  }
  return plan;
}
