// Instrument library domain logic (spec §4 kept-feature 4). Instruments
// are lab-wide (not project-scoped) so screeners and scales are reusable
// across studies; studies attach them where needed (screeners in 2.4).
// Definitions are immutable per version: editing creates a new version so
// collected responses always reference exactly what was asked.
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Instrument,
  instruments,
  type InstrumentVersion,
  instrumentVersions,
  type Member,
} from "../db/schema.ts";
import { audit } from "../audit/log.ts";
import {
  type FormItem,
  parseItems,
  parseScoring,
  type ScoringRule,
} from "./forms.ts";
import type { AuditCtx } from "./studies.ts";

export class InstrumentError extends Error {}

export type InstrumentKind = Instrument["kind"];
export type InstrumentPurpose = Instrument["purpose"];

export const INSTRUMENT_PURPOSES: InstrumentPurpose[] = [
  "screener",
  "diary",
  "consent_addon",
  "other",
];

export interface VersionContent {
  /** Builder output for simple forms (validated here). */
  items?: unknown;
  scoring?: unknown;
  /** Link for external-instrument records (Qualtrics, interview guide…). */
  externalUrl?: string;
}

interface ValidatedContent {
  items: FormItem[] | null;
  scoring: ScoringRule[] | null;
  externalUrl: string | null;
}

function validateContent(
  kind: InstrumentKind,
  content: VersionContent,
): ValidatedContent {
  if (kind === "simple_form") {
    let items: FormItem[];
    let scoring: ScoringRule[];
    try {
      items = parseItems(content.items);
      scoring = parseScoring(content.scoring, items);
    } catch (err) {
      if (err instanceof Error) throw new InstrumentError(err.message);
      throw err;
    }
    return { items, scoring, externalUrl: null };
  }
  const url = content.externalUrl?.trim() ?? "";
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new InstrumentError(
      "External instruments need a valid http(s) URL.",
    );
  }
  return { items: null, scoring: null, externalUrl: url };
}

export async function createInstrument(
  db: Db,
  opts: {
    name: string;
    kind: InstrumentKind;
    purpose: InstrumentPurpose;
    content: VersionContent;
    createdBy: Member;
  } & AuditCtx,
): Promise<Instrument> {
  const name = opts.name.trim();
  if (!name) throw new InstrumentError("Instrument name is required.");
  const content = validateContent(opts.kind, opts.content);

  return await db.transaction(async (tx) => {
    const [instrument] = await tx
      .insert(instruments)
      .values({
        name,
        kind: opts.kind,
        purpose: opts.purpose,
        currentVersion: 1,
        createdBy: opts.createdBy.id,
      })
      .returning();
    await tx.insert(instrumentVersions).values({
      instrumentId: instrument.id,
      versionNumber: 1,
      items: content.items,
      scoring: content.scoring,
      externalUrl: content.externalUrl,
      createdBy: opts.createdBy.id,
    });
    await audit(tx, {
      action: "instrument.created",
      actorId: opts.createdBy.id,
      objectType: "instrument",
      objectId: instrument.id,
      details: { name, kind: opts.kind, purpose: opts.purpose },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return instrument;
  });
}

export async function addInstrumentVersion(
  db: Db,
  opts: {
    instrument: Instrument;
    content: VersionContent;
    changeNote: string;
    actor: Member;
  } & AuditCtx,
): Promise<InstrumentVersion> {
  const changeNote = opts.changeNote.trim();
  if (!changeNote) {
    throw new InstrumentError(
      "A change note is required when revising an instrument.",
    );
  }
  const content = validateContent(opts.instrument.kind, opts.content);
  const nextVersion = opts.instrument.currentVersion + 1;

  return await db.transaction(async (tx) => {
    const [version] = await tx
      .insert(instrumentVersions)
      .values({
        instrumentId: opts.instrument.id,
        versionNumber: nextVersion,
        items: content.items,
        scoring: content.scoring,
        externalUrl: content.externalUrl,
        changeNote,
        createdBy: opts.actor.id,
      })
      .returning();
    await tx
      .update(instruments)
      .set({ currentVersion: nextVersion, updatedAt: new Date() })
      .where(eq(instruments.id, opts.instrument.id));
    await audit(tx, {
      action: "instrument.version_added",
      actorId: opts.actor.id,
      objectType: "instrument",
      objectId: opts.instrument.id,
      details: { version: nextVersion, changeNote },
      requestId: opts.requestId,
      ip: opts.ip,
    });
    return version;
  });
}

export async function getInstrument(
  db: Db,
  instrumentId: string,
): Promise<Instrument | null> {
  const instrument = await db.query.instruments.findFirst({
    where: eq(instruments.id, instrumentId),
  });
  return instrument ?? null;
}

export async function listInstruments(db: Db): Promise<Instrument[]> {
  return await db
    .select()
    .from(instruments)
    .orderBy(desc(instruments.updatedAt));
}

export async function listVersions(
  db: Db,
  instrumentId: string,
): Promise<InstrumentVersion[]> {
  return await db
    .select()
    .from(instrumentVersions)
    .where(eq(instrumentVersions.instrumentId, instrumentId))
    .orderBy(asc(instrumentVersions.versionNumber));
}

export async function getVersion(
  db: Db,
  instrumentId: string,
  versionNumber: number,
): Promise<InstrumentVersion | null> {
  const versions = await db
    .select()
    .from(instrumentVersions)
    .where(eq(instrumentVersions.instrumentId, instrumentId));
  return versions.find((v) => v.versionNumber === versionNumber) ?? null;
}

/** Parsed form definition of a stored version (simple forms only). */
export function versionForm(
  version: InstrumentVersion,
): { items: FormItem[]; scoring: ScoringRule[] } {
  const items = parseItems(version.items);
  return { items, scoring: parseScoring(version.scoring, items) };
}
