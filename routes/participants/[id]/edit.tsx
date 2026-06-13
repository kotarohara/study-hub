import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import {
  getParticipant,
  ParticipantError,
  updateParticipant,
} from "../../../lib/objects/participants.ts";
import { audit } from "../../../lib/audit/log.ts";
import { Layout } from "../../../components/Layout.tsx";

interface Values {
  name: string;
  yearOfBirth: string;
  gender: string;
  source: string;
  notes: string;
}

interface Data {
  code: string;
  participantId: string;
  error?: string;
  values: Values;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (!hasRole(ctx.state.member!.role, "assistant")) {
      throw new HttpError(403);
    }
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    // The edit form shows decrypted name/notes → PII view (spec §4).
    await audit(db, {
      action: "pii.view",
      actorId: ctx.state.member!.id,
      objectType: "participant",
      objectId: participant.id,
      details: { code: participant.code, via: "edit" },
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    });

    return page<Data>({
      code: participant.code,
      participantId: participant.id,
      values: {
        name: participant.name,
        yearOfBirth: participant.yearOfBirth?.toString() ?? "",
        gender: participant.gender,
        source: participant.source,
        notes: participant.notes,
      },
    });
  },
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    const form = await ctx.req.formData();
    const values: Values = {
      name: String(form.get("name") ?? ""),
      yearOfBirth: String(form.get("yearOfBirth") ?? "").trim(),
      gender: String(form.get("gender") ?? ""),
      source: String(form.get("source") ?? ""),
      notes: String(form.get("notes") ?? ""),
    };
    try {
      await updateParticipant(db, {
        participant,
        name: values.name,
        notes: values.notes,
        yearOfBirth: values.yearOfBirth ? Number(values.yearOfBirth) : null,
        gender: values.gender,
        source: values.source,
        actor: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
      return ctx.redirect(`/participants/${participant.id}`, 303);
    } catch (err) {
      if (err instanceof ParticipantError) {
        return page<Data>(
          {
            code: participant.code,
            participantId: participant.id,
            error: err.message,
            values,
          },
          { status: 400 },
        );
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
      title={`Edit ${data.code}`}
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
              value={values.source}
              class={INPUT_CLASS}
            />
          </label>
        </div>
        <label class="flex flex-col gap-1 text-sm">
          Notes (may contain PII — encrypted at rest)
          <textarea name="notes" rows={3} class={INPUT_CLASS}>
            {values.notes}
          </textarea>
        </label>
        <div class="flex items-center gap-3">
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Save changes
          </button>
          <a
            href={`/participants/${data.participantId}`}
            class="text-sm text-gray-600 hover:underline"
          >
            Cancel
          </a>
        </div>
      </form>
    </Layout>
  );
});
