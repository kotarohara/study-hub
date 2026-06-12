// PI-only oversight pathway change (spec §3.3: declared at creation,
// changeable by PI while the design is still editable).
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Study } from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  EDITABLE_STATES,
  getStudyFor,
  type OversightPathway,
  setOversightPathway,
  StudyError,
} from "../../../lib/objects/studies.ts";
import { Layout } from "../../../components/Layout.tsx";

interface Data {
  study: Study;
  error?: string;
}

async function loadForPi(ctx: {
  state: { member: import("../../../lib/db/schema.ts").Member | null };
  params: Record<string, string>;
}): Promise<Study> {
  const me = ctx.state.member!;
  if (!hasRole(me.role, "pi")) throw new HttpError(403);
  const found = await getStudyFor(getDb(), me, ctx.params.id);
  if (!found) throw new HttpError(404);
  if (!EDITABLE_STATES.includes(found.study.status)) throw new HttpError(409);
  return found.study;
}

export const handler = define.handlers({
  async GET(ctx) {
    return page<Data>({ study: await loadForPi(ctx) });
  },
  async POST(ctx) {
    const study = await loadForPi(ctx);
    const form = await ctx.req.formData();
    try {
      await setOversightPathway(getDb(), {
        study,
        input: {
          pathway: String(form.get("pathway") ?? "") as OversightPathway,
          exemptionReference: String(form.get("exemptionReference") ?? ""),
          justification: String(form.get("justification") ?? ""),
        },
        actor: ctx.state.member!,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/studies/${study.id}`, 303);
    } catch (err) {
      if (err instanceof StudyError) {
        return page<Data>({ study, error: err.message }, { status: 400 });
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const { study } = data;
  return (
    <Layout
      member={state.member!}
      pathname={url.pathname}
      title={`Oversight pathway: ${study.name}`}
    >
      <form
        method="post"
        class="max-w-lg space-y-4 rounded-card border border-gray-200 bg-white p-4"
      >
        {data.error && (
          <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {data.error}
          </p>
        )}
        <p class="text-sm text-gray-600">
          Current pathway:{" "}
          <strong>{study.oversightPathway}</strong>. Changes are recorded in the
          audit log.
        </p>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="pathway"
            value="irb_reviewed"
            checked={study.oversightPathway === "irb_reviewed"}
          />
          <span>
            <strong>IRB-reviewed</strong>
          </span>
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="pathway"
            value="irb_exempt"
            checked={study.oversightPathway === "irb_exempt"}
          />
          <span>
            <strong>IRB-exempt</strong> (reference required)
          </span>
        </label>
        <input
          type="text"
          name="exemptionReference"
          value={study.irbExemptionReference}
          placeholder="Exemption reference / determination"
          class="ml-6 w-full rounded-card border border-gray-300 px-3 py-1.5 text-sm"
        />
        <label class="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="pathway"
            value="internal_pilot"
            checked={study.oversightPathway === "internal_pilot"}
          />
          <span>
            <strong>Internal Pilot</strong>{" "}
            — no IRB review, permanent badge, quarantined data, no public
            recruitment (justification required)
          </span>
        </label>
        <textarea
          name="justification"
          rows={2}
          placeholder="PI justification"
          class="ml-6 w-full rounded-card border border-gray-300 px-3 py-1.5 text-sm"
        >
          {study.pilotJustification}
        </textarea>
        <div class="flex gap-2">
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Save pathway
          </button>
          <a
            href={`/studies/${study.id}`}
            class="rounded-card border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </Layout>
  );
});
