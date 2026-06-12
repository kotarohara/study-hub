// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import { auditLog, instruments, type Member, members } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import {
  addInstrumentVersion,
  createInstrument,
  getVersion,
  InstrumentError,
  listVersions,
  versionForm,
} from "./instruments.ts";

const SCREENER_ITEMS = [
  { key: "age", prompt: "Your age", type: "number", required: true, min: 18 },
  {
    key: "freq",
    prompt: "How often do you use maps apps?",
    type: "likert",
    min: 1,
    max: 5,
    minLabel: "never",
    maxLabel: "daily",
  },
];

async function withEnv(fn: (env: { researcher: Member }) => Promise<void>) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `inst-res-${suffix}@studyhub.local` })])
    .returning();
  try {
    await fn({ researcher });
  } finally {
    await db
      .delete(instruments)
      .where(eq(instruments.createdBy, researcher.id));
    await db.delete(members).where(eq(members.id, researcher.id));
    await closeTestDb();
  }
}

Deno.test("create: validates content per kind, stores v1, audited", async () => {
  await withEnv(async ({ researcher }) => {
    const db = await getTestDb();

    // Simple forms must carry valid items.
    await assert.rejects(
      () =>
        createInstrument(db, {
          name: "Broken",
          kind: "simple_form",
          purpose: "screener",
          content: { items: [], scoring: [] },
          createdBy: researcher,
        }),
      InstrumentError,
    );
    // External records must carry a valid http(s) URL.
    await assert.rejects(
      () =>
        createInstrument(db, {
          name: "Broken",
          kind: "external",
          purpose: "other",
          content: { externalUrl: "not-a-url" },
          createdBy: researcher,
        }),
      InstrumentError,
    );

    const screener = await createInstrument(db, {
      name: "Maps screener",
      kind: "simple_form",
      purpose: "screener",
      content: {
        items: SCREENER_ITEMS,
        scoring: [
          { key: "use", name: "Usage", aggregate: "mean", items: ["freq"] },
        ],
      },
      createdBy: researcher,
    });
    assert.equal(screener.currentVersion, 1);

    const v1 = await getVersion(db, screener.id, 1);
    assert.ok(v1);
    const form = versionForm(v1);
    assert.equal(form.items.length, 2);
    assert.equal(form.scoring[0].name, "Usage");

    const external = await createInstrument(db, {
      name: "Main survey",
      kind: "external",
      purpose: "other",
      content: { externalUrl: "https://example.qualtrics.com/jfe/form/SV_x" },
      createdBy: researcher,
    });
    const ev1 = await getVersion(db, external.id, 1);
    assert.equal(
      ev1?.externalUrl,
      "https://example.qualtrics.com/jfe/form/SV_x",
    );
    assert.equal(ev1?.items, null);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, screener.id));
    assert.equal(entry.action, "instrument.created");
    assert.equal(entry.details?.kind, "simple_form");
  });
});

Deno.test("versioning: change note required, old versions stay frozen", async () => {
  await withEnv(async ({ researcher }) => {
    const db = await getTestDb();
    const instrument = await createInstrument(db, {
      name: "Diary entry",
      kind: "simple_form",
      purpose: "diary",
      content: { items: SCREENER_ITEMS, scoring: [] },
      createdBy: researcher,
    });

    await assert.rejects(
      () =>
        addInstrumentVersion(db, {
          instrument,
          content: { items: SCREENER_ITEMS, scoring: [] },
          changeNote: "   ",
          actor: researcher,
        }),
      /change note/,
    );
    // Revisions are validated like creations.
    await assert.rejects(
      () =>
        addInstrumentVersion(db, {
          instrument,
          content: { items: [{ key: "bad" }], scoring: [] },
          changeNote: "break it",
          actor: researcher,
        }),
      InstrumentError,
    );

    const v2 = await addInstrumentVersion(db, {
      instrument,
      content: {
        items: [
          ...SCREENER_ITEMS,
          { key: "mood", prompt: "Mood today", type: "likert", min: 1, max: 7 },
        ],
        scoring: [],
      },
      changeNote: "Added mood item",
      actor: researcher,
    });
    assert.equal(v2.versionNumber, 2);

    const [updated] = await db
      .select()
      .from(instruments)
      .where(eq(instruments.id, instrument.id));
    assert.equal(updated.currentVersion, 2);

    // v1 still has the original two items.
    const versions = await listVersions(db, instrument.id);
    assert.deepEqual(versions.map((v) => v.versionNumber), [1, 2]);
    assert.equal(versionForm(versions[0]).items.length, 2);
    assert.equal(versionForm(versions[1]).items.length, 3);

    const actions = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.objectId, instrument.id))
    ).map((e) => e.action);
    assert.ok(actions.includes("instrument.version_added"));
  });
});
