// iCalendar (RFC 5545) generation for session feeds (spec §4 kept-feature 2:
// ICS feeds). Pure, stack-free, network-free — fully unit-testable. Times
// are emitted in UTC (the "...Z" basic format); text is escaped and lines
// are folded at 75 octets as the spec requires.

export interface IcsEvent {
  /** Globally-unique, stable identifier (RFC 5545 UID). */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string;
  description?: string;
  /** Maps to STATUS; cancelled events tell clients to drop the entry. */
  status?: "confirmed" | "cancelled";
  /** Bumped on each change so clients pick up reschedules (RFC SEQUENCE). */
  sequence?: number;
}

const PRODID = "-//StudyHub//Sessions//EN";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC date in iCalendar basic format: YYYYMMDDTHHMMSSZ. */
export function formatIcsDate(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${
      pad(date.getUTCDate())
    }` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${
      pad(date.getUTCSeconds())
    }Z`
  );
}

/** Escapes a TEXT value per RFC 5545 §3.3.11 (backslash first). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds a content line to ≤75 octets, continuation lines led by a space
 * (RFC 5545 §3.1). Multi-byte characters are never split. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const segments: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    // First segment may use 75 octets; continuations reserve one for the
    // leading space inserted on join.
    const limit = segments.length === 0 ? 75 : 74;
    if (currentBytes + chBytes > limit) {
      segments.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  segments.push(current);
  return segments.join("\r\n ");
}

function line(key: string, value: string): string {
  return foldLine(`${key}:${value}`);
}

export interface CalendarOptions {
  /** Shown as the calendar's name in client apps (X-WR-CALNAME). */
  name: string;
  events: IcsEvent[];
  /** DTSTAMP for every event; defaults to now. Injectable for tests. */
  now?: Date;
}

/** Builds a complete VCALENDAR document with CRLF line endings. */
export function buildCalendar(opts: CalendarOptions): string {
  const stamp = formatIcsDate(opts.now ?? new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    line("PRODID", PRODID),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    line("X-WR-CALNAME", escapeText(opts.name)),
  ];
  for (const event of opts.events) {
    lines.push(
      "BEGIN:VEVENT",
      line("UID", event.uid),
      line("DTSTAMP", stamp),
      line("DTSTART", formatIcsDate(event.start)),
      line("DTEND", formatIcsDate(event.end)),
      line("SUMMARY", escapeText(event.summary)),
    );
    if (event.location) {
      lines.push(line("LOCATION", escapeText(event.location)));
    }
    if (event.description) {
      lines.push(line("DESCRIPTION", escapeText(event.description)));
    }
    lines.push(
      line("STATUS", event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"),
    );
    lines.push(line("SEQUENCE", String(event.sequence ?? 0)));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 requires CRLF line breaks and a trailing CRLF.
  return lines.join("\r\n") + "\r\n";
}
