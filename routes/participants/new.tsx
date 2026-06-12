import { HttpError, page } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import {
  CHANNEL_KINDS,
  type ChannelInput,
  createParticipant,
  type DuplicateWarning,
  findDuplicates,
  ParticipantError,
} from "../../lib/objects/participants.ts";
import type { ContactChannelKind } from "../../lib/db/schema.ts";
import { Layout } from "../../components/Layout.tsx";

const CHANNEL_ROWS = 3;

interface Values {
  name: string;
  yearOfBirth: string;
  gender: string;
  source: string;
  notes: string;
  channels: ChannelInput[];
}

interface Data {
  error?: string;
  /** Cross-pool dedup matches — shown once, then "Create anyway" proceeds. */
  warnings?: DuplicateWarning[];
  values: Values;
}

const EMPTY: Values = {
  name: "",
  yearOfBirth: "",
  gender: "",
  source: "",
  notes: "",
  channels: [],
};

function parseValues(form: FormData): Values {
  const channels: ChannelInput[] = [];
  for (let i = 0; i < CHANNEL_ROWS; i++) {
    const kind = String(form.get(`channel_kind_${i}`) ?? "");
    const value = String(form.get(`channel_value_${i}`) ?? "").trim();
    if (!value) continue;
    if (!CHANNEL_KINDS.includes(kind as ContactChannelKind)) continue;
    channels.push({ kind: kind as ContactChannelKind, value });
  }
  return {
    name: String(form.get("name") ?? ""),
    yearOfBirth: String(form.get("yearOfBirth") ?? "").trim(),
    gender: String(form.get("gender") ?? ""),
    source: String(form.get("source") ?? ""),
    notes: String(form.get("notes") ?? ""),
    channels,
  };
}

export const handler = define.handlers({
  GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "assistant")) {
      throw new HttpError(403);
    }
    return page<Data>({ values: EMPTY });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);

    const db = getDb();
    const form = await ctx.req.formData();
    const values = parseValues(form);

    try {
      // Dedup warns but never hard-blocks (spec §3.4): surface matches
      // once, then a resubmit with confirmed=1 creates regardless.
      if (form.get("confirmed") !== "1") {
        const warnings = await findDuplicates(db, values.channels);
        if (warnings.length > 0) {
          return page<Data>({ warnings, values }, { status: 409 });
        }
      }
      const participant = await createParticipant(db, {
        name: values.name,
        notes: values.notes,
        yearOfBirth: values.yearOfBirth ? Number(values.yearOfBirth) : null,
        gender: values.gender,
        source: values.source,
        channels: values.channels,
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/participants/${participant.id}`, 303);
    } catch (err) {
      if (err instanceof ParticipantError) {
        return page<Data>({ error: err.message, values }, { status: 400 });
      }
      throw err;
    }
  },
});

const INPUT_CLASS = "rounded-card border border-gray-300 px-3 py-2";

export default define.page<typeof handler>(({ data, state, url }) => {
  const { values } = data;
  return (
    <Layout
      member={state.member!}
      pathname={url.pathname}
      title="Add participant"
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
        {data.warnings && (
          <div class="rounded-card border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p class="font-medium">Possible duplicate</p>
            <ul class="mt-1 list-inside list-disc">
              {data.warnings.map((w) => (
                <li key={w.kind}>
                  The {w.kind} matches existing participant
                  {w.participantCodes.length > 1 ? "s" : ""}{" "}
                  {w.participantCodes.join(", ")}.
                </li>
              ))}
            </ul>
            <p class="mt-1">
              Submit again to create anyway, or go back to the pool to check.
            </p>
            <input type="hidden" name="confirmed" value="1" />
          </div>
        )}

        <label class="flex flex-col gap-1 text-sm">
          Name (PII — encrypted at rest)
          <input
            type="text"
            name="name"
            required
            value={values.name}
            class={INPUT_CLASS}
          />
        </label>
        <div class="grid grid-cols-3 gap-3">
          <label class="flex flex-col gap-1 text-sm">
            Year of birth
            <input
              type="number"
              name="yearOfBirth"
              value={values.yearOfBirth}
              class={INPUT_CLASS}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Gender
            <input
              type="text"
              name="gender"
              value={values.gender}
              class={INPUT_CLASS}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Source
            <input
              type="text"
              name="source"
              placeholder="flyer, class, referral…"
              value={values.source}
              class={INPUT_CLASS}
            />
          </label>
        </div>

        <fieldset class="space-y-2">
          <legend class="text-sm font-medium">
            Contact channels (PII — encrypted at rest)
          </legend>
          {Array.from(
            { length: CHANNEL_ROWS },
            (_, i) => (
              <div key={i} class="flex gap-2">
                <select
                  name={`channel_kind_${i}`}
                  class="rounded-card border border-gray-300 px-2 py-2 text-sm"
                >
                  {CHANNEL_KINDS.map((kind) => (
                    <option
                      key={kind}
                      value={kind}
                      selected={values.channels[i]?.kind === kind}
                    >
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  name={`channel_value_${i}`}
                  value={values.channels[i]?.value ?? ""}
                  placeholder="address / handle / chat id"
                  class={`flex-1 ${INPUT_CLASS}`}
                />
              </div>
            ),
          )}
        </fieldset>

        <label class="flex flex-col gap-1 text-sm">
          Notes (may contain PII — encrypted at rest)
          <textarea name="notes" rows={3} class={INPUT_CLASS}>
            {values.notes}
          </textarea>
        </label>

        <button
          type="submit"
          class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {data.warnings ? "Create anyway" : "Add to pool"}
        </button>
      </form>
    </Layout>
  );
});
