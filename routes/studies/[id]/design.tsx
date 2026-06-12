import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Condition, Study } from "../../../lib/db/schema.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  EDITABLE_STATES,
  getStudyFor,
  StudyError,
} from "../../../lib/objects/studies.ts";
import {
  DESIGN_TYPES,
  type DesignType,
  listConditions,
  parseTargetN,
  updateDesign,
} from "../../../lib/objects/design.ts";
import { Layout } from "../../../components/Layout.tsx";

interface Data {
  study: Study;
  conditions: Condition[];
  error?: string;
}

async function loadEditable(ctx: {
  state: { member: import("../../../lib/db/schema.ts").Member | null };
  params: Record<string, string>;
}) {
  const me = ctx.state.member!;
  if (!hasRole(me.role, "researcher")) throw new HttpError(403);
  const found = await getStudyFor(getDb(), me, ctx.params.id);
  if (!found) throw new HttpError(404);
  if (!EDITABLE_STATES.includes(found.study.status)) throw new HttpError(409);
  return found.study;
}

export const handler = define.handlers({
  async GET(ctx) {
    const study = await loadEditable(ctx);
    return page<Data>({
      study,
      conditions: await listConditions(getDb(), study.id),
    });
  },
  async POST(ctx) {
    const study = await loadEditable(ctx);
    const db = getDb();
    const form = await ctx.req.formData();
    const get = (name: string) => String(form.get(name) ?? "");

    try {
      const rawType = get("designType");
      const updated = await updateDesign(db, {
        study,
        fields: {
          researchQuestions: get("researchQuestions"),
          hypotheses: get("hypotheses"),
          independentVariables: get("independentVariables"),
          dependentVariables: get("dependentVariables"),
          designType: DESIGN_TYPES.includes(rawType as DesignType)
            ? (rawType as DesignType)
            : null,
          targetN: parseTargetN(get("targetN")),
          exclusionCriteria: get("exclusionCriteria"),
          counterbalancingScheme: get("counterbalancingScheme"),
        },
        actor: ctx.state.member!,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/studies/${updated.id}?tab=design`, 303);
    } catch (err) {
      if (err instanceof StudyError) {
        return page<Data>(
          {
            study,
            conditions: await listConditions(db, study.id),
            error: err.message,
          },
          { status: 400 },
        );
      }
      throw err;
    }
  },
});

function Field(props: {
  label: string;
  name: string;
  value: string;
  hint?: string;
}) {
  return (
    <label class="flex flex-col gap-1 text-sm">
      {props.label}
      {props.hint && <span class="text-xs text-gray-500">{props.hint}</span>}
      <textarea
        name={props.name}
        rows={3}
        class="rounded-card border border-gray-300 px-3 py-2"
      >
        {props.value}
      </textarea>
    </label>
  );
}

export default define.page<typeof handler>(({ data, state, url }) => {
  const { study } = data;
  return (
    <Layout
      member={state.member!}
      pathname={url.pathname}
      title={`Design: ${study.name}`}
    >
      <div class="grid max-w-5xl gap-6 lg:grid-cols-[1fr_20rem]">
        <form
          method="post"
          class="space-y-4 rounded-card border border-gray-200 bg-white p-4"
        >
          {data.error && (
            <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {data.error}
            </p>
          )}
          <Field
            label="Research questions"
            name="researchQuestions"
            value={study.researchQuestions}
            hint="One per line"
          />
          <Field
            label="Hypotheses"
            name="hypotheses"
            value={study.hypotheses}
            hint="One per line"
          />
          <div class="grid gap-4 md:grid-cols-2">
            <Field
              label="Independent variables"
              name="independentVariables"
              value={study.independentVariables}
              hint="One per line"
            />
            <Field
              label="Dependent variables"
              name="dependentVariables"
              value={study.dependentVariables}
              hint="One per line"
            />
          </div>
          <div class="grid gap-4 md:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              Design type
              <select
                name="designType"
                class="rounded-card border border-gray-300 px-3 py-2"
              >
                <option value="">— not set —</option>
                {DESIGN_TYPES.map((t) => (
                  <option key={t} value={t} selected={study.designType === t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              Target N
              <input
                type="number"
                name="targetN"
                min={1}
                value={study.targetN ?? ""}
                class="rounded-card border border-gray-300 px-3 py-2"
              />
            </label>
          </div>
          <Field
            label="Exclusion criteria"
            name="exclusionCriteria"
            value={study.exclusionCriteria}
            hint="One per line"
          />
          <Field
            label="Counterbalancing scheme"
            name="counterbalancingScheme"
            value={study.counterbalancingScheme}
            hint="Recorded as text — use G*Power / your own generator and paste the result"
          />
          <div class="flex gap-2">
            <button
              type="submit"
              class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Save design
            </button>
            <a
              href={`/studies/${study.id}?tab=design`}
              class="rounded-card border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
            >
              Done
            </a>
          </div>
        </form>

        <aside class="space-y-3 rounded-card border border-gray-200 bg-white p-4">
          <h2 class="text-sm font-semibold text-gray-900">Conditions</h2>
          {data.conditions.length === 0 && (
            <p class="text-sm text-gray-500">No conditions yet.</p>
          )}
          <ul class="space-y-1">
            {data.conditions.map((c) => (
              <li
                key={c.id}
                class="flex items-center justify-between rounded-card border border-gray-100 px-3 py-1.5 text-sm"
              >
                <span>
                  <span class="mr-2 text-xs text-gray-400">{c.position}</span>
                  {c.name}
                </span>
                <form
                  method="post"
                  action={`/studies/${study.id}/conditions/remove`}
                >
                  <input type="hidden" name="conditionId" value={c.id} />
                  <button
                    type="submit"
                    class="rounded px-1 text-gray-400 hover:text-red-600"
                    title={`Remove condition ${c.name}`}
                  >
                    ✕
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <form
            method="post"
            action={`/studies/${study.id}/conditions/add`}
            class="flex gap-2"
          >
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. control"
              class="w-full rounded-card border border-gray-300 px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Add
            </button>
          </form>
        </aside>
      </div>
    </Layout>
  );
});
