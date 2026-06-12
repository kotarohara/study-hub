import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import type { Project } from "../../lib/db/schema.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { getProjectFor } from "../../lib/objects/projects.ts";
import {
  createStudy,
  METHODOLOGIES,
  type Methodology,
  type OversightPathway,
  StudyError,
} from "../../lib/objects/studies.ts";
import { Layout } from "../../components/Layout.tsx";

const PATHWAYS: OversightPathway[] = [
  "irb_reviewed",
  "irb_exempt",
  "internal_pilot",
];

interface Data {
  project: Project;
  error?: string;
  name?: string;
  description?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "researcher")) {
      throw new HttpError(403);
    }
    const projectId = ctx.url.searchParams.get("project") ?? "";
    const project = await getProjectFor(getDb(), ctx.state.member!, projectId);
    if (!project) throw new HttpError(404);
    if (project.status !== "active") throw new HttpError(409);
    return page<Data>({ project });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();

    const form = await ctx.req.formData();
    const project = await getProjectFor(
      db,
      me,
      String(form.get("projectId") ?? ""),
    );
    if (!project) throw new HttpError(404);

    const name = String(form.get("name") ?? "");
    const description = String(form.get("description") ?? "");
    const methodology = String(form.get("methodology") ?? "");
    if (!METHODOLOGIES.includes(methodology as Methodology)) {
      return page<Data>(
        { project, error: "Pick a methodology.", name, description },
        { status: 400 },
      );
    }

    const rawPathway = String(form.get("pathway") ?? "irb_reviewed");
    if (!PATHWAYS.includes(rawPathway as OversightPathway)) {
      return page<Data>(
        { project, error: "Pick an oversight pathway.", name, description },
        { status: 400 },
      );
    }

    try {
      const study = await createStudy(db, {
        project,
        name,
        description,
        methodology: methodology as Methodology,
        pathway: {
          pathway: rawPathway as OversightPathway,
          exemptionReference: String(form.get("exemptionReference") ?? ""),
          justification: String(form.get("justification") ?? ""),
        },
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/studies/${study.id}`, 303);
    } catch (err) {
      if (err instanceof StudyError) {
        return page<Data>(
          { project, error: err.message, name, description },
          { status: 400 },
        );
      }
      throw err;
    }
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout
    member={state.member!}
    pathname={url.pathname}
    title={`New study in ${data.project.name}`}
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
      <input type="hidden" name="projectId" value={data.project.id} />
      <label class="flex flex-col gap-1 text-sm">
        Name
        <input
          type="text"
          name="name"
          required
          value={data.name ?? ""}
          class="rounded-card border border-gray-300 px-3 py-2"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Methodology
        <select
          name="methodology"
          class="rounded-card border border-gray-300 px-3 py-2"
        >
          {METHODOLOGIES.map((m) => (
            <option key={m} value={m}>{m.replaceAll("_", " ")}</option>
          ))}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Description
        <textarea
          name="description"
          rows={4}
          class="rounded-card border border-gray-300 px-3 py-2"
        >
          {data.description ?? ""}
        </textarea>
      </label>
      <fieldset class="space-y-2 rounded-card border border-gray-200 p-3">
        <legend class="px-1 text-sm font-medium">Oversight pathway</legend>
        <label class="flex items-start gap-2 text-sm">
          <input type="radio" name="pathway" value="irb_reviewed" checked />
          <span>
            <strong>IRB-reviewed</strong>{" "}
            (default) — recruiting unlocks once an approved consent document
            exists.
          </span>
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input type="radio" name="pathway" value="irb_exempt" />
          <span>
            <strong>IRB-exempt</strong>{" "}
            — your IRB formally exempted this study; the reference is required.
          </span>
        </label>
        <input
          type="text"
          name="exemptionReference"
          placeholder="Exemption reference / determination"
          class="ml-6 w-full rounded-card border border-gray-300 px-3 py-1.5 text-sm"
        />
        {state.member!.role === "pi"
          ? (
            <>
              <label class="flex items-start gap-2 text-sm">
                <input type="radio" name="pathway" value="internal_pilot" />
                <span>
                  <strong>Internal Pilot</strong>{" "}
                  — no IRB review. Carries a permanent PILOT badge; data is
                  quarantined; no public recruitment. Your confirmation and
                  justification are recorded in the audit log.
                </span>
              </label>
              <textarea
                name="justification"
                rows={2}
                placeholder="PI justification (required for pilots)"
                class="ml-6 w-full rounded-card border border-gray-300 px-3 py-1.5 text-sm"
              >
              </textarea>
            </>
          )
          : (
            <p class="ml-6 text-xs text-gray-500">
              Internal Pilot (no IRB) can only be declared by the PI.
            </p>
          )}
      </fieldset>
      <button
        type="submit"
        class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Create study
      </button>
    </form>
  </Layout>
));
