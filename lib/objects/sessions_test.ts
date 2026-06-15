// Pure-logic tests — no stack required (db-backed flows are covered by
// sessions_db_test.ts, which needs the local stack).
import assert from "node:assert/strict";
import {
  allowedSessionTransitions,
  isSessionTerminal,
  SessionError,
  validateSlotTimes,
} from "./sessions.ts";

Deno.test("validateSlotTimes: end must follow start, within 24h", () => {
  const start = new Date("2026-07-01T10:00:00Z");
  validateSlotTimes(start, new Date("2026-07-01T11:00:00Z")); // ok
  assert.throws(
    () => validateSlotTimes(start, new Date("2026-07-01T10:00:00Z")),
    /end after it starts/,
  );
  assert.throws(
    () => validateSlotTimes(start, new Date("2026-07-01T09:00:00Z")),
    SessionError,
  );
  assert.throws(
    () => validateSlotTimes(start, new Date("2026-07-03T10:00:00Z")),
    /24 hours/,
  );
  assert.throws(
    () => validateSlotTimes(new Date("nope"), new Date("2026-07-01T11:00:00Z")),
    /required/,
  );
});

Deno.test("session lifecycle: legal transitions and terminals", () => {
  assert.deepEqual(allowedSessionTransitions("open"), ["booked", "cancelled"]);
  assert.deepEqual(
    allowedSessionTransitions("booked"),
    ["completed", "no_show", "cancelled", "open"],
  );
  for (const terminal of ["completed", "no_show", "cancelled"] as const) {
    assert.equal(allowedSessionTransitions(terminal).length, 0);
    assert.equal(isSessionTerminal(terminal), true);
  }
  assert.equal(isSessionTerminal("open"), false);
  assert.equal(isSessionTerminal("booked"), false);
});
