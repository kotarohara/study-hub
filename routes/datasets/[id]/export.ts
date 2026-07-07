// Dataset export (spec §3.6, §4 audit rules): CSV / JSON / analysis-ready
// bundle at one of three privacy profiles. "full" is PI-only (stable codes
// + metadata enable cross-study joins); de-identified and OSF-ready are
// researcher+. The export is audited BEFORE bytes leave — a failed audit
// write fails the export.
import { HttpError } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";
import { listRecords } from "../../../lib/objects/datasets.ts";
import {
  applyProfile,
  EXPORT_PROFILES,
  type ExportProfile,
} from "../../../lib/export/profiles.ts";
import { csvSerialize } from "../../../lib/export/csv.ts";
import { buildBundle } from "../../../lib/export/bundle.ts";
import { getDatasetFor } from "./_shared.ts";

const FORMATS = ["csv", "json", "bundle"] as const;
type Format = (typeof FORMATS)[number];

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const found = await getDatasetFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const profile = String(
      ctx.url.searchParams.get("profile") ?? "de_identified",
    ) as ExportProfile;
    const format = String(ctx.url.searchParams.get("format") ?? "csv") as
      | Format
      | string;
    if (!EXPORT_PROFILES.includes(profile)) {
      throw new HttpError(400, "Unknown export profile.");
    }
    if (!FORMATS.includes(format as Format)) {
      throw new HttpError(400, "Unknown export format.");
    }
    if (profile === "full" && !hasRole(me.role, "pi")) {
      throw new HttpError(403, "Full exports are PI-only.");
    }
    const includePilot = profile === "full" &&
      ctx.url.searchParams.get("pilot") === "1";

    const records = await listRecords(db, found.dataset.id, {
      includePilot,
      limit: 100_000,
    });
    const output = applyProfile(records, profile, { includePilot });

    // Audit BEFORE returning data (spec §4: exports must not go unrecorded).
    await audit(db, {
      action: "export.create",
      actorId: me.id,
      objectType: "dataset",
      objectId: found.dataset.id,
      details: {
        profile,
        format,
        rows: output.rows.length,
        includePilot,
      },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    const stem = `${found.dataset.name.replaceAll(/[^\w.-]/g, "_")}-${profile}`;
    if (format === "json") {
      return new Response(JSON.stringify(output.rows, null, 2) + "\n", {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${stem}.json"`,
        },
      });
    }
    if (format === "bundle") {
      const zip = buildBundle({
        datasetName: found.dataset.name,
        studyName: found.study.name,
        profile,
        output,
        exportedAt: new Date(),
      });
      return new Response(zip.slice().buffer as ArrayBuffer, {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${stem}.zip"`,
        },
      });
    }
    return new Response(csvSerialize(output.columns, output.rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${stem}.csv"`,
      },
    });
  },
});
