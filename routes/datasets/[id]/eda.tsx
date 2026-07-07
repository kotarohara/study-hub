// EDA page (spec §3.6): serializes the dataset's pilot-quarantined records
// (≤100k rows) with condition linkage and derived scale scores, then hands
// them to the client-side EdaCharts island. Pilot rows never reach the
// browser here.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { listRecords } from "../../../lib/objects/datasets.ts";
import {
  applyScaleScores,
  studyScoringForms,
} from "../../../lib/eda/scale_scores.ts";
import { numericColumns } from "../../../lib/eda/stats.ts";
import { getDatasetFor } from "./_shared.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";
import EdaCharts, { type EdaRow } from "../../../islands/EdaCharts.tsx";

const EDA_ROW_LIMIT = 100_000;

interface Data {
  datasetId: string;
  datasetName: string;
  studyId: string;
  studyName: string;
  rows: EdaRow[];
  numericKeys: string[];
}

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getDatasetFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);

    const records = await listRecords(db, found.dataset.id, {
      limit: EDA_ROW_LIMIT, // pilot excluded by default — quarantine holds
    });
    const forms = await studyScoringForms(db, found.study.id);
    const scored = applyScaleScores(
      records.map(({ record }) => record.data),
      forms,
    );
    const rows: EdaRow[] = records.map((r, i) => ({
      condition: r.conditionName,
      data: scored[i],
    }));
    return page<Data>({
      datasetId: found.dataset.id,
      datasetName: found.dataset.name,
      studyId: found.study.id,
      studyName: found.study.name,
      rows,
      numericKeys: numericColumns(rows.map((r) => r.data)),
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Explore">
    <div class="mb-4 flex items-center gap-2">
      <Chip
        href={`/studies/${data.studyId}?tab=data`}
        icon="⚗"
        label={data.studyName}
      />
      <Chip
        href={`/datasets/${data.datasetId}`}
        icon="▦"
        label={data.datasetName}
      />
    </div>
    <h1 class="mb-1 text-xl font-bold text-gray-900">
      Explore {data.datasetName}
    </h1>
    <p class="mb-6 text-sm text-gray-500">
      Pilot records are quarantined out. Scale scores from instrument rules
      appear as <code>scale_*</code>{" "}
      variables. For inferential statistics, export and analyze locally.
    </p>
    <EdaCharts rows={data.rows} numericKeys={data.numericKeys} />
  </Layout>
));
