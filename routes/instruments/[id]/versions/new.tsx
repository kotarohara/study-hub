import { HttpError, page } from "fresh";
import { define } from "../../../../utils.ts";
import { getDb } from "../../../../lib/db/client.ts";
import { hasRole } from "../../../../lib/auth/roles.ts";
import { clientHost } from "../../../../lib/auth/limiters.ts";
import type { Instrument } from "../../../../lib/db/schema.ts";
import {
  addInstrumentVersion,
  getInstrument,
  getVersion,
  InstrumentError,
} from "../../../../lib/objects/instruments.ts";
import { FormError } from "../../../../lib/objects/forms.ts";
import { Layout } from "../../../../components/Layout.tsx";
import FormBuilder from "../../../../islands/FormBuilder.tsx";

interface Data {
  instrument: Instrument;
  error?: string;
  externalUrl: string;
  changeNote: string;
  items: unknown[];
  scoring: unknown[];
}

function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const handler = define.handlers({
  async GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "researcher")) {
      throw new HttpError(403);
    }
    const db = getDb();
    const instrument = await getInstrument(db, ctx.params.id);
    if (!instrument) throw new HttpError(404);
    const current = await getVersion(
      db,
      instrument.id,
      instrument.currentVersion,
    );
    if (!current) throw new HttpError(404);

    return page<Data>({
      instrument,
      externalUrl: current.externalUrl ?? "",
      changeNote: "",
      items: current.items ?? [],
      scoring: current.scoring ?? [],
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const instrument = await getInstrument(db, ctx.params.id);
    if (!instrument) throw new HttpError(404);

    const form = await ctx.req.formData();
    const externalUrl = String(form.get("externalUrl") ?? "");
    const changeNote = String(form.get("changeNote") ?? "");
    const items = parseJsonArray(form.get("items"));
    const scoring = parseJsonArray(form.get("scoring"));

    try {
      await addInstrumentVersion(db, {
        instrument,
        content: { items, scoring, externalUrl },
        changeNote,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/instruments/${instrument.id}?tab=versions`, 303);
    } catch (err) {
      if (err instanceof InstrumentError || err instanceof FormError) {
        return page<Data>(
          {
            instrument,
            error: err.message,
            externalUrl,
            changeNote,
            items,
            scoring,
          },
          { status: 400 },
        );
      }
      throw err;
    }
  },
});

const INPUT_CLASS = "rounded-card border border-gray-300 px-3 py-2";

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout
    member={state.member!}
    pathname={url.pathname}
    title={`Revise ${data.instrument.name}`}
  >
    <p class="mb-4 max-w-2xl text-sm text-gray-600">
      Revising creates{" "}
      <strong>v{data.instrument.currentVersion + 1}</strong>; earlier versions
      stay frozen so collected responses keep referencing exactly what was
      asked.
    </p>
    <form
      method="post"
      class="max-w-2xl space-y-4 rounded-card border border-gray-200 bg-white p-4"
    >
      {data.error && (
        <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {data.error}
        </p>
      )}

      {data.instrument.kind === "external"
        ? (
          <label class="flex flex-col gap-1 text-sm">
            URL of the external instrument
            <input
              type="url"
              name="externalUrl"
              required
              value={data.externalUrl}
              class={INPUT_CLASS}
            />
          </label>
        )
        : (
          <FormBuilder
            initialItems={data.items}
            initialScoring={data.scoring}
          />
        )}

      <label class="flex flex-col gap-1 text-sm">
        What changed and why
        <textarea
          name="changeNote"
          required
          rows={2}
          class={INPUT_CLASS}
        >
          {data.changeNote}
        </textarea>
      </label>

      <button
        type="submit"
        class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Create v{data.instrument.currentVersion + 1}
      </button>
    </form>
  </Layout>
));
