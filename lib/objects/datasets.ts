// Dataset domain logic (spec §2.1, §3.6, §4 kept-feature 5). A Dataset is a
// study's logical collection of collected data: records (form responses,
// imported rows) with pseudonymous linkage, plus uploaded files in the
// FileStore. Two invariants live here:
//   - record payloads carry research data only — linkage is by enrollment
//     (participant code + condition resolved at read time), never PII;
//   - pilot quarantine: records inherit `isPilot` from their enrollment at
//     insert time and are EXCLUDED from listings/counts by default.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  conditions,
  type Dataset,
  type DatasetFile,
  datasetFiles,
  type DatasetRecord,
  datasetRecords,
  datasets,
  enrollments,
  type Member,
  participants,
  type Study,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import { errorChainIncludes } from "../db/errors.ts";
import type { AuditCtx } from "./studies.ts";

export class DatasetError extends Error {}

// --- dataset CRUD ---------------------------------------------------------

export async function createDataset(
  db: Db,
  opts: {
    study: Study;
    name: string;
    description?: string;
    createdBy: Member;
  } & AuditCtx,
): Promise<Dataset> {
  const name = opts.name.trim();
  if (!name) throw new DatasetError("Dataset name is required.");
  let dataset: Dataset;
  try {
    [dataset] = await db
      .insert(datasets)
      .values({
        studyId: opts.study.id,
        name,
        description: opts.description?.trim() ?? "",
        createdBy: opts.createdBy.id,
      })
      .returning();
  } catch (err) {
    if (errorChainIncludes(err, "datasets_study_name_unique")) {
      throw new DatasetError(
        "This study already has a dataset with that name.",
      );
    }
    throw err;
  }
  await audit(db, {
    action: "dataset.created",
    actorId: opts.createdBy.id,
    objectType: "dataset",
    objectId: dataset.id,
    details: { studyId: opts.study.id, name },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return dataset;
}

export async function getDataset(
  db: Db,
  datasetId: string,
): Promise<Dataset | null> {
  const dataset = await db.query.datasets.findFirst({
    where: eq(datasets.id, datasetId),
  });
  return dataset ?? null;
}

/** Finds a study's dataset by name, or creates it (used by the automatic
 * response capture, so screener/diary data lands in a well-known place). */
export async function ensureDataset(
  db: Db,
  opts: { study: Study; name: string; description?: string; createdBy: string },
): Promise<Dataset> {
  const existing = await db.query.datasets.findFirst({
    where: and(
      eq(datasets.studyId, opts.study.id),
      eq(datasets.name, opts.name),
    ),
  });
  if (existing) return existing;
  try {
    const [dataset] = await db
      .insert(datasets)
      .values({
        studyId: opts.study.id,
        name: opts.name,
        description: opts.description ?? "",
        createdBy: opts.createdBy,
      })
      .returning();
    return dataset;
  } catch (err) {
    // Lost a create race — the other writer's row is the one we want.
    if (errorChainIncludes(err, "datasets_study_name_unique")) {
      const raced = await db.query.datasets.findFirst({
        where: and(
          eq(datasets.studyId, opts.study.id),
          eq(datasets.name, opts.name),
        ),
      });
      if (raced) return raced;
    }
    throw err;
  }
}

export interface DatasetSummary {
  dataset: Dataset;
  records: number;
  pilotRecords: number;
  files: number;
}

export async function listDatasetsOfStudy(
  db: Db,
  studyId: string,
): Promise<DatasetSummary[]> {
  const rows = await db
    .select()
    .from(datasets)
    .where(eq(datasets.studyId, studyId))
    .orderBy(asc(datasets.createdAt));
  const summaries: DatasetSummary[] = [];
  for (const dataset of rows) {
    const recs = await db
      .select({ isPilot: datasetRecords.isPilot })
      .from(datasetRecords)
      .where(eq(datasetRecords.datasetId, dataset.id));
    const files = await db
      .select({ id: datasetFiles.id })
      .from(datasetFiles)
      .where(eq(datasetFiles.datasetId, dataset.id));
    summaries.push({
      dataset,
      records: recs.filter((r) => !r.isPilot).length,
      pilotRecords: recs.filter((r) => r.isPilot).length,
      files: files.length,
    });
  }
  return summaries;
}

/** Well-known dataset that automatic capture writes into (spec §8 "4.2 Form
 * responses captured as Dataset records"). */
export const RESPONSES_DATASET = "Responses";

/**
 * Captures one form response (screener submission, diary entry) as a record
 * in the study's "Responses" dataset, creating the dataset on first use.
 * The auto-created dataset is attributed to the study's creator (capture is
 * participant-initiated — there is no member actor). Idempotent per
 * sourceKey. Callers run this inside the same transaction as the response
 * write, so a response and its dataset record land (or fail) together.
 */
export async function captureResponse(
  db: Db,
  opts: {
    study: Study;
    enrollmentId: string;
    data: Record<string, unknown>;
    sourceKey: string;
    sessionId?: string | null;
  },
): Promise<void> {
  const dataset = await ensureDataset(db, {
    study: opts.study,
    name: RESPONSES_DATASET,
    description: "Automatically captured form responses.",
    createdBy: opts.study.createdBy,
  });
  await addRecords(db, {
    dataset,
    rows: [{
      enrollmentId: opts.enrollmentId,
      sessionId: opts.sessionId ?? null,
      data: opts.data,
      sourceKey: opts.sourceKey,
    }],
  });
}

// --- records ---------------------------------------------------------------

export interface RecordInput {
  enrollmentId?: string | null;
  sessionId?: string | null;
  data: Record<string, unknown>;
  /** Provenance + idempotency key; a repeat insert is skipped. */
  sourceKey?: string | null;
}

export interface AddRecordsResult {
  inserted: number;
  /** Rows skipped because their sourceKey already existed. */
  deduped: number;
}

/**
 * Bulk-inserts records, resolving each linked enrollment's pilot flag at
 * insert time (quarantine is decided when data lands, so promoting a pilot
 * study later never un-quarantines old rows). Idempotent per sourceKey.
 */
export async function addRecords(
  db: Db,
  opts: { dataset: Dataset; rows: RecordInput[] },
): Promise<AddRecordsResult> {
  if (opts.rows.length === 0) return { inserted: 0, deduped: 0 };

  const enrollmentIds = [
    ...new Set(
      opts.rows.map((r) => r.enrollmentId).filter((id): id is string => !!id),
    ),
  ];
  const pilotById = new Map<string, boolean>();
  if (enrollmentIds.length > 0) {
    const found = await db
      .select({ id: enrollments.id, isPilot: enrollments.isPilot })
      .from(enrollments)
      .where(inArray(enrollments.id, enrollmentIds));
    for (const row of found) pilotById.set(row.id, row.isPilot);
    const missing = enrollmentIds.filter((id) => !pilotById.has(id));
    if (missing.length > 0) {
      throw new DatasetError("A record references an unknown enrollment.");
    }
  }

  const inserted = await db
    .insert(datasetRecords)
    .values(opts.rows.map((row) => ({
      datasetId: opts.dataset.id,
      enrollmentId: row.enrollmentId ?? null,
      sessionId: row.sessionId ?? null,
      data: row.data,
      sourceKey: row.sourceKey ?? null,
      isPilot: row.enrollmentId
        ? pilotById.get(row.enrollmentId) ?? false
        : false,
    })))
    .onConflictDoNothing()
    .returning({ id: datasetRecords.id });
  return {
    inserted: inserted.length,
    deduped: opts.rows.length - inserted.length,
  };
}

/** A record with its pseudonymous linkage resolved — participant code and
 * condition name, never PII. */
export interface LinkedRecord {
  record: DatasetRecord;
  participantCode: string | null;
  conditionName: string | null;
}

/**
 * Lists a dataset's records with linkage resolved. Pilot records are
 * excluded unless `includePilot` — the quarantine default (spec §4).
 */
export async function listRecords(
  db: Db,
  datasetId: string,
  opts: { includePilot?: boolean; limit?: number } = {},
): Promise<LinkedRecord[]> {
  const filters = [eq(datasetRecords.datasetId, datasetId)];
  if (!opts.includePilot) filters.push(eq(datasetRecords.isPilot, false));

  const rows = await db
    .select({
      record: datasetRecords,
      participantCode: participants.code,
      conditionName: conditions.name,
    })
    .from(datasetRecords)
    .leftJoin(enrollments, eq(datasetRecords.enrollmentId, enrollments.id))
    .leftJoin(participants, eq(enrollments.participantId, participants.id))
    .leftJoin(conditions, eq(enrollments.conditionId, conditions.id))
    .where(and(...filters))
    .orderBy(asc(datasetRecords.createdAt))
    .limit(opts.limit ?? 10_000);
  return rows;
}

/** Union of keys across record payloads, in first-seen order — the columns
 * a tabular view/export shows. */
export function recordColumns(records: LinkedRecord[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const { record } of records) {
    for (const key of Object.keys(record.data)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

// --- files ------------------------------------------------------------------

export function datasetFileKey(datasetId: string, fileName: string): string {
  const safe = fileName.replaceAll(/[^\w.\-]/g, "_").slice(0, 120);
  return `datasets/${datasetId}/${crypto.randomUUID()}-${safe}`;
}

/**
 * Registers an uploaded file on a dataset (the route streams the bytes to
 * the FileStore first, then records it here). Audited — a data file may
 * contain anything the researcher collected.
 */
export async function addDatasetFile(
  db: Db,
  opts: {
    dataset: Dataset;
    fileKey: string;
    fileName: string;
    contentType?: string;
    sizeBytes: number;
    uploadedBy: Member;
  } & AuditCtx,
): Promise<DatasetFile> {
  const [file] = await db
    .insert(datasetFiles)
    .values({
      datasetId: opts.dataset.id,
      fileKey: opts.fileKey,
      fileName: opts.fileName,
      contentType: opts.contentType ?? "",
      sizeBytes: opts.sizeBytes,
      uploadedBy: opts.uploadedBy.id,
    })
    .returning();
  await audit(db, {
    action: "dataset.file_uploaded",
    actorId: opts.uploadedBy.id,
    objectType: "dataset",
    objectId: opts.dataset.id,
    details: { fileName: opts.fileName, sizeBytes: opts.sizeBytes },
    requestId: opts.requestId,
    ip: opts.ip,
  });
  return file;
}

export async function listDatasetFiles(
  db: Db,
  datasetId: string,
): Promise<DatasetFile[]> {
  return await db
    .select()
    .from(datasetFiles)
    .where(eq(datasetFiles.datasetId, datasetId))
    .orderBy(desc(datasetFiles.createdAt));
}

export async function getDatasetFile(
  db: Db,
  datasetId: string,
  fileId: string,
): Promise<DatasetFile | null> {
  const file = await db.query.datasetFiles.findFirst({
    where: and(
      eq(datasetFiles.id, fileId),
      eq(datasetFiles.datasetId, datasetId),
    ),
  });
  return file ?? null;
}
