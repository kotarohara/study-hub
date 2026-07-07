// Withdrawal workflow (spec §3.4, assistant+): confirm the withdrawal and
// record what the signed consent permits for already-collected data. The
// bare status transition is not enough — this page also cancels future
// diary prompts and frees booked sessions, and (when consent requires)
// deletes the enrollment's collected records.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { EnrollmentError } from "../../../lib/objects/enrollments.ts";
import {
  type WithdrawalDataHandling,
  withdrawEnrollment,
} from "../../../lib/objects/withdrawal.ts";
import { enrollmentHome, getEnrollmentFor } from "./_shared.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";

interface Data {
  enrollmentId: string;
  studyId: string;
  studyName: string;
  error?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const found = await getEnrollmentFor(getDb(), me, ctx.params.id);
    if (!found) throw new HttpError(404);
    return page<Data>({
      enrollmentId: found.enrollment.id,
      studyId: found.study.id,
      studyName: found.study.name,
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getEnrollmentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);

    const form = await ctx.req.formData();
    const dataHandling = String(form.get("dataHandling") ?? "retain");
    try {
      await withdrawEnrollment(db, {
        enrollment: found.enrollment,
        dataHandling: (dataHandling === "delete"
          ? "delete"
          : "retain") as WithdrawalDataHandling,
        reason: String(form.get("reason") ?? ""),
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof EnrollmentError) {
        return page<Data>({
          enrollmentId: found.enrollment.id,
          studyId: found.study.id,
          studyName: found.study.name,
          error: err.message,
        }, { status: 409 });
      }
      throw err;
    }
    return ctx.redirect(enrollmentHome(found.enrollment), 303);
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Withdraw">
    <div class="mb-4">
      <Chip
        href={`/studies/${data.studyId}?tab=participants`}
        icon="⚗"
        label={data.studyName}
      />
    </div>
    <h1 class="mb-2 text-xl font-bold text-gray-900">Process withdrawal</h1>
    <p class="mb-4 max-w-2xl text-sm text-gray-600">
      Withdrawing ends this participation: pending diary prompts are cancelled
      and future booked sessions return to the open pool. Choose what happens to
      data already collected, according to what the signed consent form permits.
    </p>
    {data.error && (
      <p class="mb-4 max-w-2xl rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {data.error}
      </p>
    )}
    <form method="post" class="max-w-2xl space-y-4">
      <fieldset class="space-y-2">
        <legend class="text-sm font-semibold text-gray-900">
          Collected data
        </legend>
        <label class="flex items-start gap-2 text-sm text-gray-800">
          <input type="radio" name="dataHandling" value="retain" checked />
          <span>
            <strong>Retain</strong>{" "}
            — consent permits keeping data collected before withdrawal (linked
            pseudonymously).
          </span>
        </label>
        <label class="flex items-start gap-2 text-sm text-gray-800">
          <input type="radio" name="dataHandling" value="delete" />
          <span>
            <strong>Delete</strong>{" "}
            — the participant asked for erasure: dataset records, diary entries,
            and screener answers for this enrollment are removed. Irreversible.
          </span>
        </label>
      </fieldset>
      <label class="flex flex-col gap-1 text-sm">
        Reason (optional; no PII)
        <input
          type="text"
          name="reason"
          class="max-w-md rounded-card border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      <button
        type="submit"
        class="rounded-card bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
      >
        Withdraw participant
      </button>
    </form>
  </Layout>
));
