// Outstanding-payments dashboard (spec §3.9): every unpaid compensation
// lab-wide, oldest first, with approve / mark-paid actions and totals by
// method. Pseudonymous codes only — names/phones exist solely in the
// PI-gated ledger export (4.8). New compensations are added here: pick a
// study, then an enrollment.
import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import {
  COMPENSATION_METHODS,
  type CompensationRow,
  fmtAmount,
  listOutstanding,
  type OutstandingTotals,
  outstandingTotals,
} from "../../lib/objects/compensations.ts";
import { listStudiesFor } from "../../lib/objects/studies.ts";
import {
  isTerminal,
  listEnrollmentsOfStudy,
} from "../../lib/objects/enrollments.ts";
import { getStudyFor } from "../../lib/objects/studies.ts";
import { Layout } from "../../components/Layout.tsx";
import { StatusBadge } from "../../components/ooui/StatusBadge.tsx";

const INPUT = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

interface Data {
  rows: CompensationRow[];
  totals: OutstandingTotals;
  studies: { id: string; name: string }[];
  selectedStudyId: string | null;
  enrollees: { id: string; code: string }[];
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    const db = getDb();
    const rows = await listOutstanding(db);
    const studies = (await listStudiesFor(db, me)).map((s) => ({
      id: s.study.id,
      name: s.study.name,
    }));

    const studyParam = ctx.url.searchParams.get("study");
    let selectedStudyId: string | null = null;
    let enrollees: { id: string; code: string }[] = [];
    if (studyParam) {
      const found = await getStudyFor(db, me, studyParam);
      if (!found) throw new HttpError(404);
      selectedStudyId = found.study.id;
      enrollees = (await listEnrollmentsOfStudy(db, found.study.id))
        .filter((r) =>
          !isTerminal(r.enrollment.status) ||
          r.enrollment.status === "completed"
        )
        .map((r) => ({ id: r.enrollment.id, code: r.participantCode }));
    }

    return page<Data>({
      rows,
      totals: outstandingTotals(rows),
      studies,
      selectedStudyId,
      enrollees,
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const me = state.member!;
  const canApprove = hasRole(me.role, "researcher");
  const canPay = hasRole(me.role, "assistant");
  const { totals } = data;

  return (
    <Layout member={me} pathname={url.pathname} title="Payments">
      <h1 class="mb-4 text-xl font-bold text-gray-900">
        Outstanding payments
      </h1>

      <dl class="mb-6 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-2 rounded-card border border-gray-200 bg-white p-4 text-sm md:grid-cols-4">
        <div>
          <dt class="text-xs uppercase tracking-wide text-gray-500">
            Pending
          </dt>
          <dd class="mt-0.5 text-gray-900">
            {totals.pendingCount} · {fmtAmount(totals.pendingCents)}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-gray-500">
            Approved (payable)
          </dt>
          <dd class="mt-0.5 text-gray-900">
            {totals.approvedCount} · {fmtAmount(totals.approvedCents)}
          </dd>
        </div>
        {Object.entries(totals.approvedByMethod).map(([method, cents]) => (
          <div key={method}>
            <dt class="text-xs uppercase tracking-wide text-gray-500">
              {method} run
            </dt>
            <dd class="mt-0.5 text-gray-900">{fmtAmount(cents)}</dd>
          </div>
        ))}
      </dl>

      {me.role === "pi" && (
        <section class="mb-6 max-w-3xl space-y-2 rounded-card border border-amber-200 bg-amber-50 p-4 text-sm">
          <h2 class="font-semibold text-amber-900">
            Run sheets & ledger (PII — PI only, audited)
          </h2>
          <div class="flex flex-wrap items-center gap-4">
            {Object.keys(totals.approvedByMethod).map((method) => (
              <a
                key={method}
                href={`/payments/runsheet?method=${method}`}
                class="text-brand-700 hover:underline"
              >
                {method} run sheet ↓
              </a>
            ))}
            <a href="/payments/ledger" class="text-brand-700 hover:underline">
              Reimbursement ledger ↓
            </a>
          </div>
        </section>
      )}

      {canPay && Object.keys(totals.approvedByMethod).length > 0 && (
        <form
          method="post"
          action="/payments/runsheet-paid"
          class="mb-6 flex flex-wrap items-end gap-2"
          data-confirm="Mark every approved payment of this method as paid?"
        >
          <label class="flex flex-col gap-1 text-sm">
            After paying a run sheet, close it out:
            <select name="method" class={INPUT}>
              {Object.keys(totals.approvedByMethod).map((method) => (
                <option key={method} value={method}>{method}</option>
              ))}
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Transfer reference
            <input type="text" name="reference" class={`${INPUT} w-48`} />
          </label>
          <button
            type="submit"
            class="rounded-card border border-green-600 px-3 py-1.5 text-sm text-green-700 hover:bg-green-50"
          >
            Mark all paid
          </button>
        </form>
      )}

      {data.rows.length === 0
        ? <p class="text-sm text-gray-500">Nothing outstanding. 🎉</p>
        : (
          <table class="w-full max-w-5xl text-sm">
            <thead>
              <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th class="py-2 pr-4">Participant</th>
                <th class="py-2 pr-4">Study</th>
                <th class="py-2 pr-4">Amount</th>
                <th class="py-2 pr-4">Scheme</th>
                <th class="py-2 pr-4">Method</th>
                <th class="py-2 pr-4">Status</th>
                <th class="py-2 pr-4">Created</th>
                <th class="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((
                { compensation, participantCode, studyId, studyName },
              ) => (
                <tr key={compensation.id} class="border-b border-gray-100">
                  <td class="py-2 pr-4 font-medium text-gray-800">
                    {participantCode}
                  </td>
                  <td class="py-2 pr-4">
                    <a
                      href={`/studies/${studyId}`}
                      class="text-brand-700 hover:underline"
                    >
                      {studyName}
                    </a>
                  </td>
                  <td class="py-2 pr-4">
                    {fmtAmount(compensation.amountCents, compensation.currency)}
                  </td>
                  <td class="py-2 pr-4">{compensation.scheme || "—"}</td>
                  <td class="py-2 pr-4">{compensation.method}</td>
                  <td class="py-2 pr-4">
                    <StatusBadge status={compensation.status} />
                  </td>
                  <td class="py-2 pr-4">
                    {compensation.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td class="py-2">
                    <span class="inline-flex gap-1.5">
                      {compensation.status === "pending" && canApprove && (
                        <form
                          method="post"
                          action={`/payments/${compensation.id}/approve`}
                          class="inline"
                        >
                          <button
                            type="submit"
                            class="rounded-card border border-brand-600 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50"
                          >
                            Approve
                          </button>
                        </form>
                      )}
                      {compensation.status === "approved" && canPay && (
                        <form
                          method="post"
                          action={`/payments/${compensation.id}/paid`}
                          class="inline"
                          data-confirm="Confirm this payment was made?"
                        >
                          <button
                            type="submit"
                            class="rounded-card border border-green-600 px-2 py-1 text-xs text-green-700 hover:bg-green-50"
                          >
                            Mark paid
                          </button>
                        </form>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {canApprove && (
        <section class="mt-8 max-w-2xl space-y-3 rounded-card border border-gray-200 bg-white p-4">
          <h2 class="text-sm font-semibold text-gray-900">Add compensation</h2>
          <form method="get" class="flex items-end gap-2">
            <label class="flex flex-col gap-1 text-sm">
              Study
              <select name="study" class={INPUT}>
                {data.studies.map((s) => (
                  <option
                    key={s.id}
                    value={s.id}
                    selected={s.id === data.selectedStudyId}
                  >
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Load enrollments
            </button>
          </form>

          {data.selectedStudyId && (
            data.enrollees.length === 0
              ? (
                <p class="text-sm text-gray-500">
                  No payable enrollments in this study.
                </p>
              )
              : (
                <form
                  method="post"
                  action="/payments/add"
                  class="flex flex-wrap items-end gap-2"
                >
                  <input
                    type="hidden"
                    name="studyId"
                    value={data.selectedStudyId}
                  />
                  <label class="flex flex-col gap-1 text-sm">
                    Participant
                    <select name="enrollmentId" required class={INPUT}>
                      {data.enrollees.map((e) => (
                        <option key={e.id} value={e.id}>{e.code}</option>
                      ))}
                    </select>
                  </label>
                  <label class="flex flex-col gap-1 text-sm">
                    Amount (SGD)
                    <input
                      type="number"
                      name="amount"
                      min="0.01"
                      step="0.01"
                      required
                      class={`${INPUT} w-28`}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm">
                    Method
                    <select name="method" class={INPUT}>
                      {COMPENSATION_METHODS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label class="flex flex-col gap-1 text-sm">
                    Scheme
                    <input
                      type="text"
                      name="scheme"
                      placeholder="base / bonus…"
                      class={`${INPUT} w-32`}
                    />
                  </label>
                  <label class="flex flex-col gap-1 text-sm">
                    Prolific submission (if any)
                    <input
                      type="text"
                      name="prolificSubmissionId"
                      class={`${INPUT} w-36`}
                    />
                  </label>
                  <button
                    type="submit"
                    class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                  >
                    Add
                  </button>
                </form>
              )
          )}
        </section>
      )}
    </Layout>
  );
});
