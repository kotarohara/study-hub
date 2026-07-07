// Pure tests — no DB, no network.
import assert from "node:assert/strict";
import {
  applyMapping,
  ImportError,
  parseCsv,
  parseJsonRows,
  parseTable,
} from "./importer.ts";
import { buildCodebook } from "./codebook.ts";

// --- parseCsv ---------------------------------------------------------------

Deno.test("parseCsv: headers + rows, CRLF, quoted commas and escaped quotes", () => {
  const table = parseCsv(
    'code,answer,notes\r\nP-001,4,"fine, thanks"\r\nP-002,2,"said ""ok"""\r\n',
  );
  assert.deepEqual(table.headers, ["code", "answer", "notes"]);
  assert.deepEqual(table.rows, [
    ["P-001", "4", "fine, thanks"],
    ["P-002", "2", 'said "ok"'],
  ]);
});

Deno.test("parseCsv: newlines inside quotes, ragged rows padded/truncated", () => {
  const table = parseCsv('a,b\n"line1\nline2",x\nonly-a\n1,2,3\n');
  assert.deepEqual(table.rows, [
    ["line1\nline2", "x"],
    ["only-a", ""],
    ["1", "2"],
  ]);
});

Deno.test("parseCsv: rejects empty, header-only, blank headers, bad quoting", () => {
  assert.throws(() => parseCsv(""), ImportError);
  assert.throws(() => parseCsv("a,b\n"), ImportError);
  assert.throws(() => parseCsv("a,,c\n1,2,3\n"), ImportError);
  assert.throws(() => parseCsv('a,b\n"unterminated,x\n'), ImportError);
});

// --- parseJsonRows ------------------------------------------------------------

Deno.test("parseJsonRows: array of flat objects, union headers, stringified", () => {
  const table = parseJsonRows(
    '[{"code":"P-001","mood":4},{"code":"P-002","note":"hi","tags":["a","b"]}]',
  );
  assert.deepEqual(table.headers, ["code", "mood", "note", "tags"]);
  assert.deepEqual(table.rows, [
    ["P-001", "4", "", ""],
    ["P-002", "", "hi", '["a","b"]'],
  ]);
});

Deno.test("parseJsonRows: rejects non-arrays and non-object rows", () => {
  assert.throws(() => parseJsonRows("{}"), ImportError);
  assert.throws(() => parseJsonRows("[]"), ImportError);
  assert.throws(() => parseJsonRows("[1,2]"), ImportError);
  assert.throws(() => parseJsonRows("not json"), ImportError);
});

Deno.test("parseTable: dispatches by extension", () => {
  assert.deepEqual(parseTable("x.json", '[{"a":1}]').headers, ["a"]);
  assert.deepEqual(parseTable("x.csv", "a\n1\n").headers, ["a"]);
});

// --- applyMapping --------------------------------------------------------------

const TABLE = {
  headers: ["code", "age", "mood", "secret"],
  rows: [
    ["P-001", "30", "4", "x"],
    ["", "41", "2.5", "y"],
    ["P-404", "abc", "-3", "z"],
  ],
};

Deno.test("applyMapping: extracts codes, keeps selected columns, coerces numbers", () => {
  const rows = applyMapping(TABLE, {
    codeColumn: "code",
    keepColumns: ["age", "mood"],
  });
  assert.deepEqual(rows, [
    { code: "P-001", data: { age: 30, mood: 4 } },
    { code: null, data: { age: 41, mood: 2.5 } }, // empty code → unlinked
    { code: "P-404", data: { age: "abc", mood: -3 } }, // non-numeric stays text
  ]);
});

Deno.test("applyMapping: code column is never row data; validation errors", () => {
  const rows = applyMapping(TABLE, {
    codeColumn: "code",
    keepColumns: ["code", "age"], // code filtered out of data
  });
  assert.deepEqual(Object.keys(rows[0].data), ["age"]);

  assert.throws(
    () => applyMapping(TABLE, { codeColumn: "nope", keepColumns: ["age"] }),
    ImportError,
  );
  assert.throws(
    () => applyMapping(TABLE, { codeColumn: "code", keepColumns: ["code"] }),
    ImportError,
  );
});

// --- buildCodebook --------------------------------------------------------------

Deno.test("buildCodebook: types, missingness, numeric summaries, value lists", () => {
  const codebook = buildCodebook([
    { mood: 4, device: "phone", tags: ["a"] },
    { mood: 2, device: "laptop" },
    { mood: "", device: "phone", free: "hello" },
  ]);
  const byKey = new Map(codebook.map((e) => [e.key, e]));

  const mood = byKey.get("mood")!;
  assert.equal(mood.type, "number");
  assert.equal(mood.nonMissing, 2);
  assert.equal(mood.missing, 1);
  assert.equal(mood.min, 2);
  assert.equal(mood.max, 4);
  assert.equal(mood.mean, 3);

  const device = byKey.get("device")!;
  assert.equal(device.type, "string");
  assert.deepEqual(device.values, ["laptop", "phone"]);
  assert.equal(device.distinct, 2);

  assert.equal(byKey.get("tags")!.type, "array");
  assert.equal(byKey.get("free")!.missing, 2);
});

Deno.test("buildCodebook: mixed types flagged; wide value sets not listed", () => {
  const mixed = buildCodebook([{ v: 1 }, { v: "one" }]);
  assert.equal(mixed[0].type, "mixed");

  const wide = buildCodebook(
    Array.from({ length: 30 }, (_, i) => ({ id: `v${i}` })),
  );
  assert.equal(wide[0].values, null);
  assert.equal(wide[0].distinct, 30);
});
