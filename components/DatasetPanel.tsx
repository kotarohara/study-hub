// "Data" tab of the study detail view (spec §2.1, §3.6): the study's
// datasets with record/file counts. Pilot records are counted separately —
// the quarantine is visible, not hidden.
import type { Study } from "../lib/db/schema.ts";
import type { DatasetSummary } from "../lib/objects/datasets.ts";

const INPUT = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

export function DatasetPanel(props: {
  study: Study;
  datasets: DatasetSummary[];
  canManage: boolean; // researcher+
}) {
  const { study, datasets } = props;
  return (
    <div class="space-y-8">
      <section class="space-y-2">
        <h2 class="text-sm font-semibold text-gray-900">
          Datasets ({datasets.length})
        </h2>
        {datasets.length === 0
          ? (
            <p class="text-sm text-gray-500">
              No datasets yet. Create one below — screener and diary responses
              are captured automatically into "Responses".
            </p>
          )
          : (
            <table class="w-full max-w-3xl text-sm">
              <thead>
                <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th class="py-2 pr-4">Name</th>
                  <th class="py-2 pr-4">Records</th>
                  <th class="py-2 pr-4">Pilot (quarantined)</th>
                  <th class="py-2">Files</th>
                </tr>
              </thead>
              <tbody>
                {datasets.map(({ dataset, records, pilotRecords, files }) => (
                  <tr key={dataset.id} class="border-b border-gray-100">
                    <td class="py-2 pr-4">
                      <a
                        href={`/datasets/${dataset.id}`}
                        class="font-medium text-brand-700 hover:underline"
                      >
                        {dataset.name}
                      </a>
                    </td>
                    <td class="py-2 pr-4">{records}</td>
                    <td class="py-2 pr-4">{pilotRecords}</td>
                    <td class="py-2">{files}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      {props.canManage && (
        <form
          method="post"
          action={`/studies/${study.id}/datasets/add`}
          class="flex flex-wrap items-end gap-2"
        >
          <label class="flex flex-col gap-1 text-sm">
            New dataset
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Post-task survey"
              class={INPUT}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Description
            <input type="text" name="description" class={`${INPUT} w-72`} />
          </label>
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create
          </button>
        </form>
      )}
    </div>
  );
}
