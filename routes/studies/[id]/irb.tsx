// PI-only IRB approval metadata (spec §3.3): protocol number and
// approval/expiry dates → expiry warnings + recruiting guard.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Study } from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getStudyFor, StudyError } from "../../../lib/objects/studies.ts";
import { setIrbApproval } from "../../../lib/objects/irb.ts";
import { Layout } from "../../../components/Layout.tsx";

interface Data {
  study: Study;
  error?: string;
}

function parseDate(raw: string): Date | null {
  if (!raw.trim()) return null;
  const d = new Date(raw + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new StudyError("Invalid date.");
  return d;
}

async function loadForPi(ctx: {
  state: { member: import("../../../lib/db/schema.ts").Member | null };
  params: Record<string, string>;
}): Promise<Study> {
  const me = ctx.state.member!;
  if (!hasRole(me.role, "pi")) throw new HttpError(403);
  const found = await getStudyFor(getDb(), me, ctx.params.id);
  if (!found) throw new HttpError(404);
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
      await setIrbApproval(getDb(), {
        study,
        protocolNumber: String(form.get("protocolNumber") ?? ""),
        approvedOn: parseDate(String(form.get("approvedOn") ?? "")),
        expiresOn: parseDate(String(form.get("expiresOn") ?? "")),
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
      title={`IRB approval: ${study.name}`}
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
          Recorded approval metadata drives expiry warnings and the recruiting
          guard. The change is audit-logged.
        </p>
        <label class="flex flex-col gap-1 text-sm">
          Protocol number
          <input
            type="text"
            name="protocolNumber"
            required
            value={study.irbProtocolNumber}
            class="rounded-card border border-gray-300 px-3 py-2"
          />
        </label>
        <div class="grid gap-4 md:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm">
            Approved on
            <input
              type="date"
              name="approvedOn"
              value={study.irbApprovedOn?.toISOString().slice(0, 10) ?? ""}
              class="rounded-card border border-gray-300 px-3 py-2"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Expires on
            <input
              type="date"
              name="expiresOn"
              value={study.irbExpiresOn?.toISOString().slice(0, 10) ?? ""}
              class="rounded-card border border-gray-300 px-3 py-2"
            />
          </label>
        </div>
        <div class="flex gap-2">
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Save
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
