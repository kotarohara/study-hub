// Pure tests — no DB, no network. The randomized window uses an injected
// RNG so its output is deterministic.
import assert from "node:assert/strict";
import {
  buildPromptTimes,
  DiaryScheduleError,
  type DiaryWindowConfig,
  parseDiaryConfig,
} from "./diary_schedule.ts";

const DAY = "2026-07-01T00:00:00.000Z";
const HOUR = 3600_000;

/** Deterministic RNG cycling through a fixed sequence. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

// --- parseDiaryConfig ----------------------------------------------------

Deno.test("parseDiaryConfig: accepts each window type", () => {
  assert.equal(
    parseDiaryConfig("fixed", { times: ["09:00", "20:00"] }).type,
    "fixed",
  );
  assert.equal(
    parseDiaryConfig("interval", {
      everyMinutes: 90,
      dayStart: "09:00",
      dayEnd: "18:00",
    }).type,
    "interval",
  );
  assert.equal(
    parseDiaryConfig("randomized", {
      perDay: 4,
      dayStart: "09:00",
      dayEnd: "21:00",
      minGapMinutes: 60,
    }).type,
    "randomized",
  );
});

Deno.test("parseDiaryConfig: rejects bad input", () => {
  assert.throws(
    () => parseDiaryConfig("fixed", { times: ["9am"] }),
    DiaryScheduleError,
  );
  assert.throws(
    () => parseDiaryConfig("fixed", { times: [] }),
    DiaryScheduleError,
  );
  // dayStart not before dayEnd
  assert.throws(
    () =>
      parseDiaryConfig("interval", {
        everyMinutes: 30,
        dayStart: "18:00",
        dayEnd: "09:00",
      }),
    DiaryScheduleError,
  );
  // window too short for perDay at this gap (12:00–13:00 = 60m, needs 3*30=… )
  assert.throws(
    () =>
      parseDiaryConfig("randomized", {
        perDay: 4,
        dayStart: "12:00",
        dayEnd: "13:00",
        minGapMinutes: 30,
      }),
    DiaryScheduleError,
  );
});

// --- buildPromptTimes: fixed ---------------------------------------------

Deno.test("fixed: one timestamp per time per day, in UTC", () => {
  const config: DiaryWindowConfig = {
    type: "fixed",
    times: ["09:00", "13:00"],
  };
  const times = buildPromptTimes(config, { start: new Date(DAY), days: 2 });
  assert.deepEqual(times.map((t) => t.toISOString()), [
    "2026-07-01T09:00:00.000Z",
    "2026-07-01T13:00:00.000Z",
    "2026-07-02T09:00:00.000Z",
    "2026-07-02T13:00:00.000Z",
  ]);
});

Deno.test("fixed: times before the start instant are dropped on day 0", () => {
  const config: DiaryWindowConfig = {
    type: "fixed",
    times: ["09:00", "13:00"],
  };
  const times = buildPromptTimes(config, {
    start: new Date("2026-07-01T10:00:00.000Z"),
    days: 2,
  });
  assert.deepEqual(times.map((t) => t.toISOString()), [
    "2026-07-01T13:00:00.000Z", // 09:00 dropped (before 10:00)
    "2026-07-02T09:00:00.000Z",
    "2026-07-02T13:00:00.000Z",
  ]);
});

Deno.test("days < 1 yields nothing", () => {
  const config: DiaryWindowConfig = { type: "fixed", times: ["09:00"] };
  assert.equal(
    buildPromptTimes(config, { start: new Date(DAY), days: 0 }).length,
    0,
  );
});

// --- buildPromptTimes: interval ------------------------------------------

Deno.test("interval: inclusive stepping across the daily window", () => {
  const config: DiaryWindowConfig = {
    type: "interval",
    everyMinutes: 30,
    dayStart: "09:00",
    dayEnd: "11:00",
  };
  const times = buildPromptTimes(config, { start: new Date(DAY), days: 1 });
  // 09:00, 09:30, 10:00, 10:30, 11:00
  assert.equal(times.length, 5);
  assert.equal(times[0].toISOString(), "2026-07-01T09:00:00.000Z");
  assert.equal(times[4].toISOString(), "2026-07-01T11:00:00.000Z");
});

// --- buildPromptTimes: randomized ----------------------------------------

Deno.test("randomized: deterministic with an injected RNG, spacing honored", () => {
  const config: DiaryWindowConfig = {
    type: "randomized",
    perDay: 3,
    dayStart: "09:00", // 540
    dayEnd: "21:00", // 1260, window 720, free = 720 - 2*60 = 600
    minGapMinutes: 60,
  };
  const times = buildPromptTimes(config, {
    start: new Date(DAY),
    days: 1,
    rng: seq([0.1, 0.5, 0.9]),
  });
  // offsets floor(r*601) = 60, 300, 540 → minutes 540+60, 540+300+60, 540+540+120
  assert.deepEqual(times.map((t) => t.toISOString()), [
    "2026-07-01T10:00:00.000Z", // 600 min
    "2026-07-01T15:00:00.000Z", // 900 min
    "2026-07-01T20:00:00.000Z", // 1200 min
  ]);
  // min gap (60m) honored and within the window.
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i].getTime() - times[i - 1].getTime() >= 60 * 60_000);
  }
});

Deno.test("randomized: perDay × days timestamps, sorted", () => {
  const config: DiaryWindowConfig = {
    type: "randomized",
    perDay: 2,
    dayStart: "08:00",
    dayEnd: "22:00",
    minGapMinutes: 0,
  };
  const times = buildPromptTimes(config, {
    start: new Date(DAY),
    days: 3,
    rng: seq([0.2, 0.8]),
  });
  assert.equal(times.length, 6);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i].getTime() >= times[i - 1].getTime());
  }
  void HOUR;
});
