// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import { buildCalendar, escapeText, foldLine, formatIcsDate } from "./ics.ts";

Deno.test("formatIcsDate: UTC basic format with zero padding", () => {
  assert.equal(
    formatIcsDate(new Date("2026-07-01T09:05:03Z")),
    "20260701T090503Z",
  );
  // Non-UTC input is normalized to UTC.
  assert.equal(
    formatIcsDate(new Date("2026-01-02T00:00:00+08:00")),
    "20260101T160000Z",
  );
});

Deno.test("escapeText: backslash, comma, semicolon, newline", () => {
  assert.equal(
    escapeText("a, b; c\\d\nnext"),
    "a\\, b\\; c\\\\d\\nnext",
  );
});

Deno.test("foldLine: short lines untouched, long lines folded ≤75 octets", () => {
  assert.equal(foldLine("SHORT:value"), "SHORT:value");

  const long = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(long);
  const enc = new TextEncoder();
  for (const physical of folded.split("\r\n")) {
    assert.ok(
      enc.encode(physical).length <= 75,
      `line too long: ${physical.length}`,
    );
  }
  // Continuation lines begin with a single space; unfolding restores it.
  const unfolded = folded.replace(/\r\n /g, "");
  assert.equal(unfolded, long);
});

Deno.test("buildCalendar: VCALENDAR wrapper, one VEVENT per event, CRLF", () => {
  const ics = buildCalendar({
    name: "My sessions",
    now: new Date("2026-06-01T00:00:00Z"),
    events: [
      {
        uid: "abc@studyhub",
        start: new Date("2026-07-01T10:00:00Z"),
        end: new Date("2026-07-01T11:00:00Z"),
        summary: "Interview, room 3; bring ID",
        location: "Lab 3A",
        sequence: 2,
      },
      {
        uid: "def@studyhub",
        start: new Date("2026-07-02T10:00:00Z"),
        end: new Date("2026-07-02T11:00:00Z"),
        summary: "Cancelled one",
        status: "cancelled",
      },
    ],
  });

  // CRLF line endings and a trailing CRLF.
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("\r\n"));
  assert.ok(!ics.includes("\n\n"));

  const lines = ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.includes("X-WR-CALNAME:My sessions"));
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);

  // First event: dates, escaped summary, location, status, sequence.
  assert.ok(lines.includes("UID:abc@studyhub"));
  assert.ok(lines.includes("DTSTART:20260701T100000Z"));
  assert.ok(lines.includes("DTEND:20260701T110000Z"));
  assert.ok(lines.includes("SUMMARY:Interview\\, room 3\\; bring ID"));
  assert.ok(lines.includes("LOCATION:Lab 3A"));
  assert.ok(lines.includes("DTSTAMP:20260601T000000Z"));
  assert.ok(lines.includes("SEQUENCE:2"));

  // Second event is marked cancelled; first defaults to confirmed.
  assert.equal(ics.match(/STATUS:CONFIRMED/g)?.length, 1);
  assert.equal(ics.match(/STATUS:CANCELLED/g)?.length, 1);
});

Deno.test("buildCalendar: empty event list still yields a valid skeleton", () => {
  const ics = buildCalendar({ name: "Empty", events: [] });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(ics.includes("BEGIN:VEVENT"), false);
});
