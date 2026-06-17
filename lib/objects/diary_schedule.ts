// Diary/ESM schedule builder (spec §3.8: "fixed/interval/randomized
// windows"). Pure logic: a window config plus a start instant expand into a
// concrete list of prompt timestamps, which lib/objects/diary.ts persists as
// diary_prompts. Kept side-effect-free (the RNG is injectable) so the three
// window strategies are exhaustively unit-testable and deterministic.
//
// Times of day are "HH:MM" in UTC, matching how the rest of StudyHub renders
// instants (sessions show " UTC"); a per-participant timezone is a future
// refinement, not needed for the single-lab scope.
import { z } from "zod";

export class DiaryScheduleError extends Error {}

export type DiaryWindowType = "fixed" | "interval" | "randomized";

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected a HH:MM time of day");

const FixedConfig = z.object({
  type: z.literal("fixed"),
  /** Daily prompt times, e.g. ["09:00", "13:00", "20:00"]. */
  times: z.array(HHMM).min(1, "fixed schedules need at least one time")
    .refine((t) => new Set(t).size === t.length, "times must be unique"),
});

const IntervalConfig = z.object({
  type: z.literal("interval"),
  /** Step between prompts within the daily window. */
  everyMinutes: z.number().int().min(1),
  dayStart: HHMM,
  dayEnd: HHMM,
}).refine((c) => toMinutes(c.dayStart) < toMinutes(c.dayEnd), {
  message: "dayStart must be before dayEnd",
});

const RandomizedConfig = z.object({
  type: z.literal("randomized"),
  /** How many prompts to scatter across the daily window. */
  perDay: z.number().int().min(1),
  dayStart: HHMM,
  dayEnd: HHMM,
  /** Minimum spacing between two prompts on the same day. */
  minGapMinutes: z.number().int().min(0).default(0),
}).refine((c) => toMinutes(c.dayStart) < toMinutes(c.dayEnd), {
  message: "dayStart must be before dayEnd",
}).refine(
  (c) =>
    toMinutes(c.dayEnd) - toMinutes(c.dayStart) >=
      (c.perDay - 1) * c.minGapMinutes,
  { message: "window is too short for perDay prompts at this min gap" },
);

export const DiaryWindowConfigSchema = z.discriminatedUnion("type", [
  FixedConfig,
  IntervalConfig,
  RandomizedConfig,
]);

export type DiaryWindowConfig = z.infer<typeof DiaryWindowConfigSchema>;

/** "HH:MM" → minutes past midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Validates a stored/submitted config against its declared window type. */
export function parseDiaryConfig(
  windowType: DiaryWindowType,
  input: unknown,
): DiaryWindowConfig {
  const candidate = (typeof input === "object" && input !== null)
    ? { ...(input as Record<string, unknown>), type: windowType }
    : input;
  const result = DiaryWindowConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new DiaryScheduleError(
      `Invalid diary schedule${path}: ${issue.message}`,
    );
  }
  return result.data;
}

/** UTC midnight of the given instant's calendar day, plus `dayOffset` days. */
function dayBaseMs(start: Date, dayOffset: number): number {
  return Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate() + dayOffset,
  );
}

/** Minute-of-day offsets for one day under a given config. */
function dayMinutes(
  config: DiaryWindowConfig,
  rng: () => number,
): number[] {
  switch (config.type) {
    case "fixed":
      return config.times.map(toMinutes).sort((a, b) => a - b);
    case "interval": {
      const out: number[] = [];
      const end = toMinutes(config.dayEnd);
      for (
        let m = toMinutes(config.dayStart);
        m <= end;
        m += config.everyMinutes
      ) {
        out.push(m);
      }
      return out;
    }
    case "randomized": {
      const startM = toMinutes(config.dayStart);
      const window = toMinutes(config.dayEnd) - startM;
      const free = window - (config.perDay - 1) * config.minGapMinutes;
      // Draw perDay sorted offsets in [0, free], then push each out by the
      // cumulative min gap so spacing is guaranteed and order preserved.
      const offsets = Array.from(
        { length: config.perDay },
        () => Math.floor(rng() * (free + 1)),
      ).sort((a, b) => a - b);
      return offsets.map((o, i) => startM + o + i * config.minGapMinutes);
    }
  }
}

export interface BuildOptions {
  /** First instant the diary is active; prompts before it are dropped. */
  start: Date;
  /** Calendar days to run, counting the start's day as day 0. */
  days: number;
  /** Injectable RNG for randomized windows (defaults to Math.random). */
  rng?: () => number;
}

/**
 * Expands a window config into concrete prompt instants. Times that would
 * fall before `start` (e.g. earlier today than the moment a diary begins)
 * are dropped, so generating from "now" never backfills the past. The
 * result is sorted ascending and de-duplicated.
 */
export function buildPromptTimes(
  config: DiaryWindowConfig,
  opts: BuildOptions,
): Date[] {
  if (opts.days < 1) return [];
  const rng = opts.rng ?? Math.random;
  const startMs = opts.start.getTime();
  const times: number[] = [];
  for (let day = 0; day < opts.days; day++) {
    const base = dayBaseMs(opts.start, day);
    for (const minute of dayMinutes(config, rng)) {
      times.push(base + minute * 60_000);
    }
  }
  const unique = [...new Set(times)].filter((t) => t >= startMs).sort((a, b) =>
    a - b
  );
  return unique.map((t) => new Date(t));
}
