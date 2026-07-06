// Retention & purge (spec §7, item 4.9; PI-only): participants whose
// retention timer has lapsed — every enrollment terminal, inactive past
// the window — with a PI-approved erasure action per row. Purging destroys
// PII but keeps the pseudonymous code and research records.
import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import {
  DEFAULT_RETENTION_DAYS,
  type PurgeCandidate,
  purgeCandidates,
} from "../../lib/objects/withdrawal.ts";
import { Layout } from "../../components/Layout.tsx";

interface Data {
  candidates: PurgeCandidate[];
  retentionDays: number;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "pi")) throw new HttpError(403);
    const raw = Number(ctx.url.searchParams.get("days"));
    const retentionDays = Number.isInteger(raw) && raw > 0
      ? raw
      : DEFAULT_RETENTION_DAYS;
    return page<Data>({
      candidates: await purgeCandidates(getDb(), { retentionDays }),
      retentionDays,
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Retention">
    <h1 class="mb-2 text-xl font-bold text-gray-900">Retention & purge</h1>
    <p class="mb-4 max-w-2xl text-sm text-gray-600">
      Participants with no live enrollments and no activity for the retention
      window. Purging erases PII (name, contact channels, demographics) but
      keeps the pseudonymous code and research records, so datasets stay intact.
      Every purge is audited and irreversible.
    </p>

    <form method="get" class="mb-6 flex items-end gap-2">
      <label class="flex flex-col gap-1 text-sm">
        Retention window (days)
        <input
          type="number"
          name="days"
          min={1}
          value={data.retentionDays}
          class="w-32 rounded-card border border-gray-300 px-2 py-1.5 text-sm"
        />
      </label>
      <button
        type="submit"
        class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Recalculate
      </button>
    </form>

    {data.candidates.length === 0
      ? (
        <p class="text-sm text-gray-500">
          Nothing past the retention window. 👍
        </p>
      )
      : (
        <table class="w-full max-w-3xl text-sm">
          <thead>
            <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <th class="py-2 pr-4">Participant</th>
              <th class="py-2 pr-4">Enrollments</th>
              <th class="py-2 pr-4">Inactive</th>
              <th class="py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.candidates.map((
              { participant, enrollmentCount, inactiveDays },
            ) => (
              <tr key={participant.id} class="border-b border-gray-100">
                <td class="py-2 pr-4">
                  <a
                    href={`/participants/${participant.id}`}
                    class="font-medium text-brand-700 hover:underline"
                  >
                    {participant.code}
                  </a>
                </td>
                <td class="py-2 pr-4">{enrollmentCount}</td>
                <td class="py-2 pr-4">{inactiveDays} days</td>
                <td class="py-2">
                  <form
                    method="post"
                    action={`/participants/${participant.id}/purge`}
                    class="inline"
                    data-confirm={`Erase all PII for ${participant.code}? The pseudonymous research data stays. This cannot be undone.`}
                  >
                    <button
                      type="submit"
                      class="rounded-card border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                    >
                      Purge PII
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
  </Layout>
));
