import type { Db } from "../../../lib/db/client.ts";
import type { Dataset, Member, Study } from "../../../lib/db/schema.ts";
import { getDataset } from "../../../lib/objects/datasets.ts";
import { getStudyFor } from "../../../lib/objects/studies.ts";

/** Dataset + study, only if the study is visible to `member`. */
export async function getDatasetFor(
  db: Db,
  member: Member,
  datasetId: string,
): Promise<{ dataset: Dataset; study: Study } | null> {
  const dataset = await getDataset(db, datasetId);
  if (!dataset) return null;
  const found = await getStudyFor(db, member, dataset.studyId);
  return found ? { dataset, study: found.study } : null;
}
