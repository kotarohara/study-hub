// Pure-logic tests — no stack required (filterPool/bulkInvite queries
// are covered by recruitment_db_test.ts, which needs the local stack).
import assert from "node:assert/strict";
import type { Participant } from "../db/schema.ts";
import { matchesFilter, type PoolFilter } from "./recruitment.ts";

function fakeParticipant(overrides: Partial<Participant>): Participant {
  return {
    id: "id",
    code: "P-test",
    name: "Test",
    notes: "",
    yearOfBirth: 1990,
    gender: "female",
    source: "flyer",
    doNotContact: false,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const NO_FILTER: PoolFilter = { requireRecontact: false };

Deno.test("matchesFilter: DNC never matches; empty filter matches everyone else", () => {
  assert.equal(matchesFilter(fakeParticipant({}), NO_FILTER), true);
  assert.equal(
    matchesFilter(fakeParticipant({ doNotContact: true }), NO_FILTER),
    false,
  );
});

Deno.test("matchesFilter: gender/source case-insensitive, year bounds inclusive", () => {
  const p = fakeParticipant({ gender: "Female", source: "Flyer" });
  assert.equal(
    matchesFilter(p, { ...NO_FILTER, gender: " female " }),
    true,
  );
  assert.equal(matchesFilter(p, { ...NO_FILTER, gender: "male" }), false);
  assert.equal(matchesFilter(p, { ...NO_FILTER, source: "flyer" }), true);
  assert.equal(matchesFilter(p, { ...NO_FILTER, source: "class" }), false);

  assert.equal(
    matchesFilter(p, { ...NO_FILTER, minBirthYear: 1990, maxBirthYear: 1990 }),
    true,
  );
  assert.equal(matchesFilter(p, { ...NO_FILTER, minBirthYear: 1991 }), false);
  assert.equal(matchesFilter(p, { ...NO_FILTER, maxBirthYear: 1989 }), false);
  // Unknown birth year fails any year-bounded filter.
  assert.equal(
    matchesFilter(fakeParticipant({ yearOfBirth: null }), {
      ...NO_FILTER,
      minBirthYear: 1980,
    }),
    false,
  );
});
