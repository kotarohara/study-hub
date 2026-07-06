// Integration tests — require the local stack: `deno task stack:up`
// (Postgres for all; MinIO for the file roundtrip).
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  conditions,
  type Enrollment,
  enrollments,
  type Member,
  members,
  type Participant,
  participants,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { getConfig } from "../config.ts";
import { createFileStores } from "../storage/filestore.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment } from "./enrollments.ts";
import {
  addDatasetFile,
  addRecords,
  createDataset,
  DatasetError,
  datasetFileKey,
  ensureDataset,
  getDatasetFile,
  listDatasetsOfStudy,
  listRecords,
  recordColumns,
} from "./datasets.ts";
import { importIntoDataset } from "./importer.ts";
import { addChannel } from "./participants.ts";
import { applyProfile } from "../export/profiles.ts";

interface Env {
  db: Awaited<ReturnType<typeof getTestDb>>;
  member: Member;
  study: Study;
  participant: Participant;
  enrollment: Enrollment;
  pilotEnrollment: Enrollment;
}

async function withEnv(fn: (env: Env) => Promise<void>) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [member] = await db
    .insert(members)
    .values([fakeMember({ email: `ds-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `ds-${suffix}`,
    createdBy: member,
  });
  const study = await createStudy(db, {
    project,
    name: "Data Study",
    methodology: "survey",
    createdBy: member,
  });
  const participant = await createParticipant(db, {
    name: "Ada Data",
    createdBy: member,
  });
  const pilotParticipant = await createParticipant(db, {
    name: "Bo Pilot",
    createdBy: member,
  });
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: member,
  });
  const pilotEnrollment = await createEnrollment(db, {
    study,
    participant: pilotParticipant,
    isPilot: true,
    actor: member,
  });
  try {
    await fn({ db, member, study, participant, enrollment, pilotEnrollment });
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, member.id));
    await db.delete(participants).where(eq(participants.createdBy, member.id));
    await db.delete(members).where(inArray(members.id, [member.id]));
    await closeTestDb();
  }
}

Deno.test("createDataset: validates, unique per study; ensureDataset is idempotent", async () => {
  await withEnv(async ({ db, study, member }) => {
    const dataset = await createDataset(db, {
      study,
      name: "Post-task survey",
      createdBy: member,
    });
    assert.equal(dataset.name, "Post-task survey");

    await assert.rejects(
      () =>
        createDataset(db, {
          study,
          name: "Post-task survey",
          createdBy: member,
        }),
      DatasetError,
    );
    await assert.rejects(
      () => createDataset(db, { study, name: "  ", createdBy: member }),
      DatasetError,
    );

    const ensured = await ensureDataset(db, {
      study,
      name: "Responses",
      createdBy: member.id,
    });
    const again = await ensureDataset(db, {
      study,
      name: "Responses",
      createdBy: member.id,
    });
    assert.equal(again.id, ensured.id);

    const summaries = await listDatasetsOfStudy(db, study.id);
    assert.equal(summaries.length, 2);
  });
});

Deno.test("addRecords: pilot inheritance, sourceKey idempotency, linkage on read", async () => {
  await withEnv(async ({ db, study, member, enrollment, pilotEnrollment }) => {
    // Give the real enrollment a condition so linkage resolution is visible.
    const [condition] = await db
      .insert(conditions)
      .values({ studyId: study.id, name: "control", position: 0 })
      .returning();
    await db
      .update(enrollments)
      .set({ conditionId: condition.id })
      .where(eq(enrollments.id, enrollment.id));

    const dataset = await createDataset(db, {
      study,
      name: "Responses",
      createdBy: member,
    });

    const first = await addRecords(db, {
      dataset,
      rows: [
        {
          enrollmentId: enrollment.id,
          data: { mood: 4, notes: "fine" },
          sourceKey: "test:1",
        },
        {
          enrollmentId: pilotEnrollment.id,
          data: { mood: 2 },
          sourceKey: "test:2",
        },
        { data: { mood: 5, extra: "unlinked" } }, // no enrollment
      ],
    });
    assert.deepEqual(first, { inserted: 3, deduped: 0 });

    // Re-adding the keyed rows is a no-op; the unkeyed row inserts again is
    // NOT attempted here (no sourceKey ⇒ caller owns dedup).
    const repeat = await addRecords(db, {
      dataset,
      rows: [
        { enrollmentId: enrollment.id, data: { mood: 4 }, sourceKey: "test:1" },
      ],
    });
    assert.deepEqual(repeat, { inserted: 0, deduped: 1 });

    // Unknown enrollment is refused outright.
    await assert.rejects(
      () =>
        addRecords(db, {
          dataset,
          rows: [{ enrollmentId: crypto.randomUUID(), data: {} }],
        }),
      DatasetError,
    );

    // Pilot quarantine: excluded by default…
    const visible = await listRecords(db, dataset.id);
    assert.equal(visible.length, 2);
    assert.ok(visible.every(({ record }) => !record.isPilot));
    const linked = visible.find((r) => r.participantCode !== null)!;
    assert.equal(linked.conditionName, "control");
    assert.deepEqual(linked.record.data, { mood: 4, notes: "fine" });

    // …and visible only on request, flagged.
    const all = await listRecords(db, dataset.id, { includePilot: true });
    assert.equal(all.length, 3);
    assert.equal(all.filter(({ record }) => record.isPilot).length, 1);

    // Column union preserves first-seen order.
    assert.deepEqual(recordColumns(all), ["mood", "notes", "extra"]);
  });
});

Deno.test("importIntoDataset: code linkage, unmatched kept unlinked, idempotent", async () => {
  await withEnv(async ({ db, study, member, participant, enrollment }) => {
    const dataset = await createDataset(db, {
      study,
      name: "Qualtrics export",
      createdBy: member,
    });
    const rows = [
      { code: participant.code, data: { score: 7 } },
      { code: "P-NOPE", data: { score: 3 } },
      { code: null, data: { score: 1 } },
    ];

    const first = await importIntoDataset(db, {
      dataset,
      study,
      rows,
      sourceKeyPrefix: "import:f1",
    });
    assert.equal(first.inserted, 3);
    assert.equal(first.linked, 1);
    assert.deepEqual(first.unmatchedCodes, ["P-NOPE"]);

    // Re-import of the same file is a full no-op.
    const again = await importIntoDataset(db, {
      dataset,
      study,
      rows,
      sourceKeyPrefix: "import:f1",
    });
    assert.equal(again.inserted, 0);
    assert.equal(again.deduped, 3);

    const records = await listRecords(db, dataset.id);
    assert.equal(records.length, 3);
    const linked = records.find((r) => r.participantCode === participant.code);
    assert.ok(linked);
    assert.equal(linked.record.enrollmentId, enrollment.id);
    assert.equal(records.filter((r) => r.participantCode === null).length, 2);
  });
});

Deno.test("export profiles: PII never leaks into de-identified/OSF output", async () => {
  await withEnv(async ({ db, study, member, participant, enrollment }) => {
    // The participant's real PII (name is set in withEnv; add an email).
    const PII = ["Ada Data", "ada-data@example.com"];
    await db.update(participants)
      .set({ name: "Ada Data" })
      .where(eq(participants.id, participant.id));
    await addChannel(db, {
      participant,
      channel: { kind: "email", value: "ada-data@example.com" },
      actor: member,
    });

    const dataset = await createDataset(db, {
      study,
      name: "Export test",
      createdBy: member,
    });
    await addRecords(db, {
      dataset,
      rows: [
        { enrollmentId: enrollment.id, data: { mood: 4, note: "all good" } },
        { enrollmentId: enrollment.id, data: { mood: 2, note: "tired" } },
      ],
    });
    const records = await listRecords(db, dataset.id);

    // De-identified and OSF: no name, no email, no stable code — anywhere.
    for (const profile of ["de_identified", "osf"] as const) {
      const out = applyProfile(records, profile);
      const json = JSON.stringify(out);
      for (const leak of PII) {
        assert.ok(!json.includes(leak), `${profile} leaked "${leak}"`);
      }
      assert.ok(
        !json.includes(participant.code),
        `${profile} leaked the stable code`,
      );
      assert.ok(!json.includes(enrollment.id), `${profile} leaked ids`);
    }

    // Full keeps the stable pseudonymous code — but still never PII.
    const full = applyProfile(records, "full");
    const fullJson = JSON.stringify(full);
    assert.ok(fullJson.includes(participant.code));
    for (const leak of PII) {
      assert.ok(!fullJson.includes(leak), `full leaked "${leak}"`);
    }
  });
});

Deno.test("dataset files: FileStore roundtrip + row registration", async () => {
  await withEnv(async ({ db, study, member }) => {
    const dataset = await createDataset(db, {
      study,
      name: "Files",
      createdBy: member,
    });
    const bytes = new TextEncoder().encode("participant_code,mood\nP-001,4\n");
    const key = datasetFileKey(dataset.id, "results (final).csv");
    assert.match(key, /^datasets\//);
    assert.ok(!key.includes("("), "unsafe filename characters are stripped");

    const { files } = createFileStores(getConfig());
    await files.put(key, bytes, { contentType: "text/csv" });
    try {
      const file = await addDatasetFile(db, {
        dataset,
        fileKey: key,
        fileName: "results (final).csv",
        contentType: "text/csv",
        sizeBytes: bytes.length,
        uploadedBy: member,
      });
      const found = await getDatasetFile(db, dataset.id, file.id);
      assert.ok(found);
      assert.equal(found.sizeBytes, bytes.length);

      // The bytes actually landed in the store.
      const back = await files.get(key);
      assert.deepEqual(back, bytes);

      // Foreign dataset id does not leak the file.
      assert.equal(
        await getDatasetFile(db, crypto.randomUUID(), file.id),
        null,
      );
    } finally {
      await files.delete(key);
    }
  });
});
