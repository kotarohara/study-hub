import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import {
  createInstrument,
  INSTRUMENT_PURPOSES,
  InstrumentError,
  type InstrumentKind,
  type InstrumentPurpose,
} from "../../lib/objects/instruments.ts";
import { FormError } from "../../lib/objects/forms.ts";
import { Layout } from "../../components/Layout.tsx";
import FormBuilder from "../../islands/FormBuilder.tsx";

interface Data {
  kind: InstrumentKind;
  error?: string;
  name: string;
  purpose: string;
  externalUrl: string;
  /** Echo of the submitted builder JSON so a failed POST keeps edits. */
  items: unknown[];
  scoring: unknown[];
}

/** Hidden-input JSON → array, tolerating garbage (server re-validates). */
function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const handler = define.handlers({
  GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "researcher")) {
      throw new HttpError(403);
    }
    const kind: InstrumentKind = ctx.url.searchParams.get("kind") === "external"
      ? "external"
      : "simple_form";
    return page<Data>({
      kind,
      name: "",
      purpose: "other",
      externalUrl: "",
      items: [],
      scoring: [],
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);

    const form = await ctx.req.formData();
    const kind: InstrumentKind = form.get("kind") === "external"
      ? "external"
      : "simple_form";
    const name = String(form.get("name") ?? "");
    const purpose = String(form.get("purpose") ?? "other");
    const externalUrl = String(form.get("externalUrl") ?? "");
    const items = parseJsonArray(form.get("items"));
    const scoring = parseJsonArray(form.get("scoring"));

    try {
      const instrument = await createInstrument(getDb(), {
        name,
        kind,
        purpose: (INSTRUMENT_PURPOSES as string[]).includes(purpose)
          ? purpose as InstrumentPurpose
          : "other",
        content: { items, scoring, externalUrl },
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/instruments/${instrument.id}`, 303);
    } catch (err) {
      if (err instanceof InstrumentError || err instanceof FormError) {
        return page<Data>(
          {
            kind,
            error: err.message,
            name,
            purpose,
            externalUrl,
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
    title="New instrument"
  >
    <div class="mb-4 flex gap-1 border-b border-gray-200">
      {(
        [
          ["simple_form", "Simple form"],
          ["external", "External record"],
        ] as const
      ).map(([kind, label]) => (
        <a
          key={kind}
          href={`/instruments/new${
            kind === "external" ? "?kind=external" : ""
          }`}
          class={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
            kind === data.kind
              ? "border-brand-600 text-brand-700"
              : "border-transparent text-gray-500 hover:text-gray-800"
          }`}
        >
          {label}
        </a>
      ))}
    </div>

    <form
      method="post"
      class="max-w-2xl space-y-4 rounded-card border border-gray-200 bg-white p-4"
    >
      <input type="hidden" name="kind" value={data.kind} />
      {data.error && (
        <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {data.error}
        </p>
      )}
      <div class="flex flex-wrap gap-3">
        <label class="flex flex-1 flex-col gap-1 text-sm">
          Name
          <input
            type="text"
            name="name"
            required
            value={data.name}
            placeholder={data.kind === "external"
              ? "e.g. Main survey (Qualtrics)"
              : "e.g. Smartphone-use screener"}
            class={INPUT_CLASS}
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Purpose
          <select name="purpose" class={INPUT_CLASS}>
            {INSTRUMENT_PURPOSES.map((purpose) => (
              <option
                key={purpose}
                value={purpose}
                selected={purpose === data.purpose}
              >
                {purpose.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data.kind === "external"
        ? (
          <label class="flex flex-col gap-1 text-sm">
            URL of the external instrument
            <input
              type="url"
              name="externalUrl"
              required
              value={data.externalUrl}
              placeholder="https://nus.qualtrics.com/…"
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

      <button
        type="submit"
        class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Create instrument
      </button>
    </form>
  </Layout>
));
