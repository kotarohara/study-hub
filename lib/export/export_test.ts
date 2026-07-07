// Pure tests — no DB. The de-identification RNG is injected so id
// assignment and shuffling are deterministic. The end-to-end no-PII proof
// with real encrypted participants lives in datasets_db_test.ts.
import assert from "node:assert/strict";
import type { LinkedRecord } from "../objects/datasets.ts";
import type { DatasetRecord } from "../db/schema.ts";
import { applyProfile } from "./profiles.ts";
import { csvSerialize } from "./csv.ts";
import { buildBundle } from "./bundle.ts";
import { crc32, zipStore } from "./zip.ts";

function record(
  overrides: Partial<DatasetRecord> & { data: Record<string, unknown> },
): DatasetRecord {
  return {
    id: crypto.randomUUID(),
    datasetId: "d",
    enrollmentId: "e",
    sessionId: null,
    sourceKey: null,
    isPilot: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  } as DatasetRecord;
}

function linked(
  code: string | null,
  condition: string | null,
  data: Record<string, unknown>,
  isPilot = false,
): LinkedRecord {
  return {
    record: record({ data, isPilot }),
    participantCode: code,
    conditionName: condition,
  };
}

const RECORDS: LinkedRecord[] = [
  linked("P-AAA", "control", { mood: 4, essay: "long text one" }),
  linked("P-BBB", "treatment", { mood: 2, essay: "long text two" }),
  linked("P-AAA", "control", { mood: 5, essay: "long text three" }),
  linked("P-PIL", "control", { mood: 1, essay: "pilot words" }, true),
];

const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

Deno.test("full profile: metadata + stable codes; pilot only on request", () => {
  const out = applyProfile(RECORDS, "full");
  assert.equal(out.rows.length, 3); // pilot excluded by default
  assert.deepEqual(
    out.columns.slice(0, 6),
    [
      "participant_code",
      "condition",
      "session_id",
      "source_key",
      "is_pilot",
      "recorded_at",
    ],
  );
  assert.equal(out.rows[0].participant_code, "P-AAA");

  const withPilot = applyProfile(RECORDS, "full", { includePilot: true });
  assert.equal(withPilot.rows.length, 4);
  assert.equal(withPilot.rows.filter((r) => r.is_pilot === true).length, 1);
});

Deno.test("de_identified: fresh ids, same person same id, no metadata, no stable codes, pilot never", () => {
  const out = applyProfile(RECORDS, "de_identified", { rng: seq([0]) });
  assert.deepEqual(out.columns, ["participant", "condition", "mood", "essay"]);
  assert.equal(out.rows.length, 3);

  const json = JSON.stringify(out);
  assert.ok(!json.includes("P-AAA"), "stable code must not appear");
  assert.ok(!json.includes("P-PIL"), "pilot rows/codes must not appear");
  assert.ok(!json.includes("recorded_at"));
  assert.ok(!json.includes("source_key"));

  // The two P-AAA rows share one fresh id; P-BBB gets a different one.
  const ids = out.rows.map((r) => r.participant as string);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => /^P\d{3}$/.test(id)));
  const byMood = new Map(out.rows.map((r) => [r.mood, r.participant]));
  assert.equal(byMood.get(4), byMood.get(5)); // both P-AAA rows
  assert.notEqual(byMood.get(4), byMood.get(2));
});

Deno.test("osf: de-identified minus open-ended text columns", () => {
  // 21+ distinct essay values → open-ended → dropped; device (2 values) kept.
  const many: LinkedRecord[] = Array.from(
    { length: 22 },
    (_, i) =>
      linked(`P-${i}`, "control", {
        mood: i,
        device: i % 2 ? "phone" : "laptop",
        essay: `unique reflection number ${i}`,
      }),
  );
  const out = applyProfile(many, "osf", { rng: seq([0]) });
  assert.deepEqual(out.columns, ["participant", "condition", "mood", "device"]);
  assert.ok(!JSON.stringify(out).includes("unique reflection"));
});

Deno.test("csvSerialize: quoting, CRLF, arrays joined", () => {
  const csv = csvSerialize(["a", "b"], [
    { a: 'say "hi", ok', b: ["x", "y"] },
    { a: null, b: 7 },
  ]);
  assert.equal(
    csv,
    'a,b\r\n"say ""hi"", ok",x; y\r\n,7\r\n',
  );
});

Deno.test("zipStore: unzip lists and extracts the entries intact", async () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);

  const zip = zipStore([
    { name: "data.csv", content: "a,b\r\n1,2\r\n" },
    { name: "README.txt", content: "hello" },
  ]);
  // Structural signatures: local header, central directory, EOCD.
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual([...zip.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06]);

  // Real-world proof: system unzip can extract it.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/bundle.zip`;
    await Deno.writeFile(path, zip);
    const out = await new Deno.Command("unzip", {
      args: ["-o", path, "-d", dir],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
    assert.equal(await Deno.readTextFile(`${dir}/README.txt`), "hello");
    assert.equal(await Deno.readTextFile(`${dir}/data.csv`), "a,b\r\n1,2\r\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildBundle: contains data, codebook, loaders, README", () => {
  const zip = buildBundle({
    datasetName: "Responses",
    studyName: "Sleep Study",
    profile: "de_identified",
    output: {
      columns: ["participant", "mood"],
      rows: [{ participant: "P001", mood: 4 }],
    },
    exportedAt: new Date("2026-07-01T00:00:00Z"),
  });
  const text = new TextDecoder("latin1").decode(zip);
  for (
    const name of ["data.csv", "codebook.json", "load.R", "load.py", "README"]
  ) {
    assert.ok(text.includes(name), `bundle should contain ${name}`);
  }
  assert.ok(text.includes("DE-IDENTIFIED"));
});
