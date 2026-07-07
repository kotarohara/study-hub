// CSV serialization (RFC 4180): quotes fields containing commas, quotes,
// or newlines; doubles embedded quotes; CRLF row endings so Excel and R
// read it identically. Pure.

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvSerialize(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  const lines = [columns.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
