// Public screener page (spec §3.4): no auth — the URL token is the
// capability. Protected by rate limiting + Turnstile (stubbed outside
// production). Submissions create Participant + Enrollment; eligibility
// is never revealed to the participant.
import { page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { getConfig } from "../../../lib/config.ts";
import { RateLimiter } from "../../../lib/rate_limit.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { verifyTurnstile } from "../../../lib/integrations/turnstile.ts";
import { getStudy } from "../../../lib/objects/studies.ts";
import {
  getScreenerByToken,
  isScreenerLive,
  recordScreenerView,
  type ScreenerDefinition,
  screenerDefinition,
  submitScreener,
} from "../../../lib/objects/screeners.ts";
import {
  type Answers,
  type FormItem,
  type RawAnswers,
  validateResponse,
} from "../../../lib/objects/forms.ts";
import { PublicLayout } from "../../../components/PublicLayout.tsx";
import { FormRender } from "../../../components/FormRender.tsx";

/** Generous for humans, hostile to scripts: 10 burst, ~1/min refill. */
const screenerLimiter = new RateLimiter({
  capacity: 10,
  refillPerSecond: 1 / 60,
});

interface Data {
  state: "closed" | "form" | "done";
  studyName?: string;
  definition?: ScreenerDefinition;
  siteKey?: string;
  error?: string;
  values?: RawAnswers;
  contact?: { name: string; email: string };
  errors?: Record<string, string>;
}

const CLOSED = { state: "closed" } as const;

async function loadLive(token: string) {
  const db = getDb();
  const screener = await getScreenerByToken(db, token);
  if (!screener) return null;
  const study = await getStudy(db, screener.studyId);
  if (!study || !isScreenerLive(screener, study)) return null;
  return { db, screener, study };
}

function rawAnswers(
  form: FormData,
  definition: ScreenerDefinition,
): RawAnswers {
  const raw: RawAnswers = {};
  for (const item of definition.items) {
    raw[item.key] = item.type === "multi_choice"
      ? form.getAll(item.key).map(String)
      : String(form.get(item.key) ?? "");
  }
  return raw;
}

/** Raw form echoes → the typed values FormRender re-checks inputs with. */
function displayValues(items: FormItem[], raw: RawAnswers): Answers {
  const values: Answers = {};
  for (const item of items) {
    const value = raw[item.key];
    if (value === undefined) continue;
    if (item.type === "number" || item.type === "likert") {
      const n = Number(value);
      if (String(value).trim() !== "" && Number.isFinite(n)) {
        values[item.key] = n;
      }
    } else {
      values[item.key] = value;
    }
  }
  return values;
}

export const handler = define.handlers({
  async GET(ctx) {
    const live = await loadLive(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });

    await recordScreenerView(live.db, live.screener);
    return page<Data>({
      state: "form",
      studyName: live.study.name,
      definition: await screenerDefinition(live.db, live.screener),
      siteKey: getConfig().TURNSTILE_SITE_KEY,
    });
  },
  async POST(ctx) {
    if (!screenerLimiter.check(clientHost(ctx.info))) {
      return new Response("Too many requests — try again later.", {
        status: 429,
      });
    }
    const live = await loadLive(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });
    const definition = await screenerDefinition(live.db, live.screener);

    const form = await ctx.req.formData();
    const config = getConfig();
    const human = await verifyTurnstile({
      config,
      token: String(form.get("cf-turnstile-response") ?? ""),
      ip: clientHost(ctx.info),
    });

    const contact = {
      name: String(form.get("contact_name") ?? "").trim(),
      email: String(form.get("contact_email") ?? "").trim(),
    };
    const raw = rawAnswers(form, definition);
    const { errors } = validateResponse(definition.items, raw);
    if (!contact.name) errors.contact_name = "Your name is required.";
    if (!contact.email.includes("@")) {
      errors.contact_email = "A valid email is required.";
    }

    if (!human || Object.keys(errors).length > 0) {
      return page<Data>({
        state: "form",
        studyName: live.study.name,
        definition,
        siteKey: config.TURNSTILE_SITE_KEY,
        error: human
          ? "Please fix the highlighted answers."
          : "Verification failed — please try again.",
        values: raw,
        contact,
        errors,
      }, { status: 400 });
    }

    await submitScreener(live.db, {
      screener: live.screener,
      study: live.study,
      definition,
      raw,
      contact,
      ip: clientHost(ctx.info),
      requestId: ctx.state.requestId,
    });
    return page<Data>({ state: "done", studyName: live.study.name });
  },
});

const INPUT_CLASS =
  "rounded-card border border-gray-300 px-3 py-2 text-sm w-full max-w-md";

export default define.page<typeof handler>(({ data }) => {
  if (data.state === "closed") {
    return (
      <PublicLayout title="Not available">
        <p class="text-sm text-gray-700">
          This page does not exist or is no longer accepting responses.
        </p>
      </PublicLayout>
    );
  }
  if (data.state === "done") {
    return (
      <PublicLayout title="Thank you!">
        <p class="text-sm text-gray-700">
          Your answers for <strong>{data.studyName}</strong>{" "}
          were recorded. If you are a match for this study, the research team
          will contact you using the details you provided.
        </p>
      </PublicLayout>
    );
  }

  const { definition } = data;
  const values = data.values ?? {};
  return (
    <PublicLayout title={`${data.studyName} — interest form`}>
      <form method="post" class="space-y-6">
        {data.error && (
          <p
            role="alert"
            class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {data.error}
          </p>
        )}

        <FormRender
          items={definition!.items}
          values={displayValues(definition!.items, values)}
          errors={data.errors}
        />

        <fieldset class="space-y-3 border-t border-gray-200 pt-4">
          <legend class="pt-4 text-sm font-semibold text-gray-900">
            How can we reach you?
          </legend>
          <label class="flex flex-col gap-1 text-sm">
            Name <span class="sr-only">(required)</span>
            {data.errors?.contact_name && (
              <span class="text-red-700">{data.errors.contact_name}</span>
            )}
            <input
              type="text"
              name="contact_name"
              required
              value={data.contact?.name ?? ""}
              class={INPUT_CLASS}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Email
            {data.errors?.contact_email && (
              <span class="text-red-700">{data.errors.contact_email}</span>
            )}
            <input
              type="email"
              name="contact_email"
              required
              value={data.contact?.email ?? ""}
              class={INPUT_CLASS}
            />
          </label>
          <p class="text-xs text-gray-500">
            Your contact details are stored encrypted and used only to reach you
            about this study.
          </p>
        </fieldset>

        {data.siteKey
          ? (
            <>
              <script
                src="https://challenges.cloudflare.com/turnstile/api.js"
                async
                defer
              />
              <div class="cf-turnstile" data-sitekey={data.siteKey} />
            </>
          )
          : (
            // Dev/test stub: the adapter accepts any token locally.
            <input type="hidden" name="cf-turnstile-response" value="dev" />
          )}

        <button
          type="submit"
          class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Submit
        </button>
      </form>
    </PublicLayout>
  );
});
