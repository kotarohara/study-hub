// Column-mapping import (spec §3.5 "generic CSV mapper", researcher+):
// pick a stored CSV/JSON dataset file, choose which column carries the
// pseudonymous participant code (linkage) and which columns to keep, then
// import. Idempotent per file+row, audited.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { getConfig } from "../../../lib/config.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";
import { createFileStores } from "../../../lib/storage/filestore.ts";
import { getDatasetFile } from "../../../lib/objects/datasets.ts";
import {
  applyMapping,
  ImportError,
  importIntoDataset,
  type ParsedTable,
  parseTable,
} from "../../../lib/objects/importer.ts";
import { getDatasetFor } from "./_shared.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";

const PREVIEW_ROWS = 5;

interface Data {
  datasetId: string;
  datasetName: string;
  fileId: string;
  fileName: string;
  headers: string[];
  preview: string[][];
  totalRows: number;
  error?: string;
}

async function loadTable(
  datasetId: string,
  member: Parameters<typeof getDatasetFor>[1],
  fileId: string,
) {
  const db = getDb();
  const found = await getDatasetFor(db, member, datasetId);
  if (!found) throw new HttpError(404);
  const file = await getDatasetFile(db, found.dataset.id, fileId);
  if (!file) throw new HttpError(404);
  const bytes = await createFileStores(getConfig()).files.get(file.fileKey);
  let table: ParsedTable;
  try {
    table = parseTable(file.fileName, new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof ImportError) throw new HttpError(400, err.message);
    throw err;
  }
  return { db, ...found, file, table };
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const fileId = ctx.url.searchParams.get("file") ?? "";
    const live = await loadTable(ctx.params.id, me, fileId);
    return page<Data>({
      datasetId: live.dataset.id,
      datasetName: live.dataset.name,
      fileId: live.file.id,
      fileName: live.file.fileName,
      headers: live.table.headers,
      preview: live.table.rows.slice(0, PREVIEW_ROWS),
      totalRows: live.table.rows.length,
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const form = await ctx.req.formData();
    const fileId = String(form.get("fileId") ?? "");
    const live = await loadTable(ctx.params.id, me, fileId);

    const rawCode = String(form.get("codeColumn") ?? "");
    const mapping = {
      codeColumn: rawCode === "" ? null : rawCode,
      keepColumns: form.getAll("keep").map(String),
    };
    try {
      const rows = applyMapping(live.table, mapping);
      const result = await importIntoDataset(live.db, {
        dataset: live.dataset,
        study: live.study,
        rows,
        sourceKeyPrefix: `import:${live.file.id}`,
      });
      await audit(live.db, {
        action: "dataset.imported",
        actorId: me.id,
        objectType: "dataset",
        objectId: live.dataset.id,
        details: {
          fileName: live.file.fileName,
          inserted: result.inserted,
          deduped: result.deduped,
          linked: result.linked,
          unmatched: result.unmatchedCodes.length,
        },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      const query = new URLSearchParams({
        imported: String(result.inserted),
        deduped: String(result.deduped),
        linked: String(result.linked),
        unmatched: String(result.unmatchedCodes.length),
      });
      return ctx.redirect(`/datasets/${live.dataset.id}?${query}`, 303);
    } catch (err) {
      if (err instanceof ImportError) {
        return page<Data>({
          datasetId: live.dataset.id,
          datasetName: live.dataset.name,
          fileId: live.file.id,
          fileName: live.file.fileName,
          headers: live.table.headers,
          preview: live.table.rows.slice(0, PREVIEW_ROWS),
          totalRows: live.table.rows.length,
          error: err.message,
        }, { status: 400 });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Import data">
    <div class="mb-4">
      <Chip
        href={`/datasets/${data.datasetId}`}
        icon="▦"
        label={data.datasetName}
      />
    </div>
    <h1 class="mb-1 text-xl font-bold text-gray-900">
      Import {data.fileName}
    </h1>
    <p class="mb-4 text-sm text-gray-500">
      {data.totalRows} row{data.totalRows === 1 ? "" : "s"}{" "}
      detected. Map the columns, then import — re-importing the same file never
      duplicates rows.
    </p>
    {data.error && (
      <p class="mb-4 max-w-2xl rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {data.error}
      </p>
    )}

    <div class="mb-6 overflow-x-auto">
      <table class="text-sm">
        <thead>
          <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
            {data.headers.map((h) => <th key={h} class="py-2 pr-4">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.preview.map((row, i) => (
            <tr key={i} class="border-b border-gray-100">
              {row.map((cell, j) => (
                <td key={j} class="py-1.5 pr-4 text-gray-700">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <form method="post" class="max-w-2xl space-y-4">
      <input type="hidden" name="fileId" value={data.fileId} />
      <label class="flex flex-col gap-1 text-sm">
        Participant code column (links rows to enrollments; optional)
        <select
          name="codeColumn"
          class="max-w-xs rounded-card border border-gray-300 px-2 py-1.5 text-sm"
        >
          <option value="">— none (unlinked import) —</option>
          {data.headers.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </label>

      <fieldset class="space-y-1">
        <legend class="text-sm font-medium text-gray-900">
          Columns to import
        </legend>
        {data.headers.map((h) => (
          <label key={h} class="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" name="keep" value={h} checked />
            {h}
          </label>
        ))}
      </fieldset>

      <button
        type="submit"
        class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Import rows
      </button>
    </form>
  </Layout>
));
