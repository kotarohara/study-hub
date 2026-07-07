// PayNow/PayPal/Prolific run sheet (spec §3.9): the CSV a lab member pays
// from. PII-bearing (names + payment addresses) → PI-only and audited as a
// PII export BEFORE bytes leave.
import { HttpError } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { audit } from "../../lib/audit/log.ts";
import {
  COMPENSATION_METHODS,
  fmtAmount,
} from "../../lib/objects/compensations.ts";
import { runSheet } from "../../lib/objects/ledger.ts";
import { csvSerialize } from "../../lib/export/csv.ts";
import type { CompensationMethod } from "../../lib/db/schema.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "pi")) throw new HttpError(403);
    const method = String(ctx.url.searchParams.get("method") ?? "");
    if (!COMPENSATION_METHODS.includes(method as CompensationMethod)) {
      throw new HttpError(400, "Unknown payment method.");
    }
    const db = getDb();
    const rows = await runSheet(db, method as CompensationMethod);

    await audit(db, {
      action: "pii.export",
      actorId: me.id,
      objectType: "compensation",
      details: { kind: "run_sheet", method, rows: rows.length },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    const csv = csvSerialize(
      [
        "name",
        "pay_to",
        "amount",
        "scheme",
        "study",
        "prolific_submission",
        "compensation_id",
      ],
      rows.map((row) => ({
        name: row.name,
        pay_to: row.payTo,
        amount: fmtAmount(row.amountCents, row.currency),
        scheme: row.scheme,
        study: row.studyName,
        prolific_submission: row.prolificSubmissionId,
        compensation_id: row.compensationId,
      })),
    );
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="runsheet-${method}.csv"`,
      },
    });
  },
});
