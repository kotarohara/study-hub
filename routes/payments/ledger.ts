// Reimbursement ledger export (spec §3.9, item 4.8): Name / Phone Number /
// Amount (+ date, method, reference) for every PAID compensation. The one
// deliberately PII-bearing export in the system — PI-only, audited BEFORE
// bytes leave (a failed audit write fails the export).
import { HttpError } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { audit } from "../../lib/audit/log.ts";
import { fmtAmount } from "../../lib/objects/compensations.ts";
import { ledgerRows } from "../../lib/objects/ledger.ts";
import { csvSerialize } from "../../lib/export/csv.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "pi")) throw new HttpError(403);
    const db = getDb();
    const rows = await ledgerRows(db);

    await audit(db, {
      action: "pii.export",
      actorId: me.id,
      objectType: "compensation",
      details: { kind: "ledger", rows: rows.length },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    const csv = csvSerialize(
      [
        "name",
        "phone_number",
        "compensation_amount",
        "paid_on",
        "method",
        "reference",
      ],
      rows.map((row) => ({
        name: row.name,
        phone_number: row.phone,
        compensation_amount: fmtAmount(row.amountCents, row.currency),
        paid_on: row.paidAt?.toISOString().slice(0, 10) ?? "",
        method: row.method,
        reference: row.reference,
      })),
    );
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition":
          'attachment; filename="reimbursement-ledger.csv"',
      },
    });
  },
});
