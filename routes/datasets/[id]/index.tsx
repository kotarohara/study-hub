// Dataset detail view (spec §2.1, §3.6): records preview with pseudonymous
// linkage (participant code + condition — never PII) and the file shelf.
// Pilot records are quarantined out of the table by default; the toggle
// shows them explicitly labelled (they never sneak into stats or exports).
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import type { Dataset, DatasetFile } from "../../../lib/db/schema.ts";
import {
  type LinkedRecord,
  listDatasetFiles,
  listRecords,
  recordColumns,
} from "../../../lib/objects/datasets.ts";
import { getDatasetFor } from "./_shared.ts";
import { Layout } from "../../../components/Layout.tsx";
import { DetailView } from "../../../components/ooui/DetailView.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";
import { StatusBadge } from "../../../components/ooui/StatusBadge.tsx";

const PREVIEW_LIMIT = 50;

interface Data {
  dataset: Dataset;
  studyId: string;
  studyName: string;
  records: LinkedRecord[];
  columns: string[];
  totalShown: number;
  includePilot: boolean;
  files: DatasetFile[];
}

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getDatasetFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);
    const includePilot = ctx.url.searchParams.get("pilot") === "1";
    const records = await listRecords(db, found.dataset.id, { includePilot });
    return page<Data>({
      dataset: found.dataset,
      studyId: found.study.id,
      studyName: found.study.name,
      records: records.slice(0, PREVIEW_LIMIT),
      columns: recordColumns(records),
      totalShown: records.length,
      includePilot,
      files: await listDatasetFiles(db, found.dataset.id),
    });
  },
});

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const { dataset, records, columns } = data;
  const canUpload = hasRole(me.role, "assistant");

  return (
    <Layout member={me} pathname={url.pathname}>
      <DetailView
        icon="▦"
        typeLabel="Dataset"
        title={dataset.name}
        properties={[
          { label: "Records shown", value: data.totalShown },
          { label: "Files", value: data.files.length },
          {
            label: "Created",
            value: dataset.createdAt.toISOString().slice(0, 10),
          },
        ]}
        tabs={[]}
        activeTab=""
        baseHref={`/datasets/${dataset.id}`}
        actions={[]}
      >
        <div class="mb-4">
          <Chip
            href={`/studies/${data.studyId}?tab=data`}
            icon="⚗"
            label={data.studyName}
          />
        </div>

        {dataset.description && (
          <p class="mb-4 max-w-2xl text-sm text-gray-700">
            {dataset.description}
          </p>
        )}

        <section class="mb-8 space-y-2">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-gray-900">
              Records ({data.totalShown}
              {data.totalShown > PREVIEW_LIMIT
                ? `, first ${PREVIEW_LIMIT} shown`
                : ""})
            </h2>
            <a
              href={`/datasets/${dataset.id}${
                data.includePilot ? "" : "?pilot=1"
              }`}
              class="text-xs text-brand-700 hover:underline"
            >
              {data.includePilot
                ? "Hide pilot records"
                : "Show quarantined pilot records"}
            </a>
          </div>
          {records.length === 0
            ? (
              <p class="text-sm text-gray-500">
                No records yet. Responses are captured automatically; imports
                and uploads land here too.
              </p>
            )
            : (
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                      <th class="py-2 pr-4">Participant</th>
                      <th class="py-2 pr-4">Condition</th>
                      {columns.map((c) => (
                        <th key={c} class="py-2 pr-4">{c}</th>
                      ))}
                      {data.includePilot && <th class="py-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((
                      { record, participantCode, conditionName },
                    ) => (
                      <tr key={record.id} class="border-b border-gray-100">
                        <td class="py-2 pr-4 font-medium text-gray-800">
                          {participantCode ?? "—"}
                        </td>
                        <td class="py-2 pr-4">{conditionName ?? "—"}</td>
                        {columns.map((c) => (
                          <td key={c} class="py-2 pr-4">
                            {cell(record.data[c])}
                          </td>
                        ))}
                        {data.includePilot && (
                          <td class="py-2">
                            {record.isPilot && <StatusBadge status="pilot" />}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>

        <section class="max-w-2xl space-y-3">
          <h2 class="text-sm font-semibold text-gray-900">
            Files ({data.files.length})
          </h2>
          {data.files.length > 0 && (
            <ul class="space-y-1">
              {data.files.map((file) => (
                <li
                  key={file.id}
                  class="flex items-center justify-between rounded-card border border-gray-200 bg-white px-3 py-2 text-sm"
                >
                  <span class="text-gray-800">
                    {file.fileName}{" "}
                    <span class="text-xs text-gray-500">
                      ({fmtBytes(file.sizeBytes)})
                    </span>
                  </span>
                  <a
                    href={`/datasets/${dataset.id}/files/${file.id}/download`}
                    class="text-xs text-brand-700 hover:underline"
                  >
                    Download ↓
                  </a>
                </li>
              ))}
            </ul>
          )}
          {canUpload && (
            <form
              method="post"
              action={`/datasets/${dataset.id}/upload`}
              enctype="multipart/form-data"
              class="flex items-center gap-2"
            >
              <input type="file" name="file" required class="text-sm" />
              <button
                type="submit"
                class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Upload
              </button>
            </form>
          )}
        </section>
      </DetailView>
    </Layout>
  );
});
