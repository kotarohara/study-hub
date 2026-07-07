// Participant diary entry page (spec §3.8). Reached from a diary-prompt
// message's magic link (purpose "diary"); the token is the capability, so
// there is no account or Turnstile — just rate limiting. Submits store one
// diary_response and close the prompt. When the study opts into quick
// replies and the form is a single choice/likert question, the options
// render as one-tap buttons.
import { page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { RateLimiter } from "../../../lib/rate_limit.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getStudy } from "../../../lib/objects/studies.ts";
import {
  diaryDefinition,
  getDiarySchedule,
  getPrompt,
  submitDiaryEntry,
  verifyDiaryToken,
} from "../../../lib/objects/diary.ts";
import type {
  Answers,
  FormItem,
  RawAnswers,
} from "../../../lib/objects/forms.ts";
import { PublicLayout } from "../../../components/PublicLayout.tsx";
import { FormRender } from "../../../components/FormRender.tsx";

const diaryLimiter = new RateLimiter({ capacity: 12, refillPerSecond: 1 / 60 });

interface Data {
  state: "closed" | "expired" | "form" | "done";
  studyName?: string;
  items?: FormItem[];
  values?: RawAnswers;
  errors?: Record<string, string>;
  quick?: boolean;
  error?: string;
}

const CLOSED = { state: "closed" } as const;

async function load(token: string) {
  const promptId = verifyDiaryToken(token);
  if (!promptId) return null;
  const db = getDb();
  const prompt = await getPrompt(db, promptId);
  if (!prompt) return null;
  const schedule = await getDiarySchedule(db, prompt.studyId);
  if (!schedule) return null;
  const study = await getStudy(db, prompt.studyId);
  if (!study) return null;
  const { items } = await diaryDefinition(db, schedule);
  return { db, prompt, schedule, study, items };
}

/** A single choice/likert question can be answered in one tap. */
function isQuick(quickReply: boolean, items: FormItem[]): boolean {
  return quickReply && items.length === 1 &&
    (items[0].type === "single_choice" || items[0].type === "likert");
}

function rawAnswers(form: FormData, items: FormItem[]): RawAnswers {
  const raw: RawAnswers = {};
  for (const item of items) {
    raw[item.key] = item.type === "multi_choice"
      ? form.getAll(item.key).map(String)
      : String(form.get(item.key) ?? "");
  }
  return raw;
}

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
    const live = await load(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });
    if (live.prompt.status === "answered") {
      return page<Data>({ state: "done", studyName: live.study.name });
    }
    if (
      live.prompt.status === "missed" || live.prompt.status === "cancelled" ||
      live.prompt.expiresAt.getTime() <= Date.now()
    ) {
      return page<Data>({ state: "expired", studyName: live.study.name });
    }
    return page<Data>({
      state: "form",
      studyName: live.study.name,
      items: live.items,
      quick: isQuick(live.schedule.quickReply, live.items),
    });
  },
  async POST(ctx) {
    if (!diaryLimiter.check(clientHost(ctx.info))) {
      return new Response("Too many requests — try again later.", {
        status: 429,
      });
    }
    const live = await load(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });

    const form = await ctx.req.formData();
    const raw = rawAnswers(form, live.items);
    const result = await submitDiaryEntry(live.db, {
      prompt: live.prompt,
      items: live.items,
      instrumentVersionNumber: live.schedule.instrumentVersionNumber,
      raw,
    });

    if (result.ok) {
      return page<Data>({ state: "done", studyName: live.study.name });
    }
    if (result.closed) {
      return page<Data>({ state: "expired", studyName: live.study.name });
    }
    return page<Data>({
      state: "form",
      studyName: live.study.name,
      items: live.items,
      quick: isQuick(live.schedule.quickReply, live.items),
      values: raw,
      errors: result.errors,
      error: "Please fix the highlighted answer.",
    }, { status: 400 });
  },
});

function QuickReply({ item }: { item: FormItem }) {
  const options = item.type === "single_choice"
    ? item.options
    : item.type === "likert"
    ? Array.from({ length: item.max - item.min + 1 }, (_, i) =>
      String(item.min + i))
    : [];
  return (
    <form method="post" class="space-y-4">
      <p class="text-sm font-medium text-gray-900">{item.prompt}</p>
      <div class="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="submit"
            name={item.key}
            value={option}
            class="rounded-card border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800 hover:bg-brand-100"
          >
            {option}
          </button>
        ))}
      </div>
    </form>
  );
}

export default define.page<typeof handler>(({ data }) => {
  if (data.state === "closed") {
    return (
      <PublicLayout title="Not available">
        <p class="text-sm text-gray-700">
          This diary link is invalid or has expired. No action is needed.
        </p>
      </PublicLayout>
    );
  }
  if (data.state === "expired") {
    return (
      <PublicLayout title="This entry has closed">
        <p class="text-sm text-gray-700">
          The window for this {data.studyName}{" "}
          diary entry has passed — thanks all the same. Watch for the next
          prompt.
        </p>
      </PublicLayout>
    );
  }
  if (data.state === "done") {
    return (
      <PublicLayout title="Thank you!">
        <p class="text-sm text-gray-700">
          Your {data.studyName}{" "}
          diary entry was recorded. See you at the next prompt!
        </p>
      </PublicLayout>
    );
  }

  const items = data.items ?? [];
  return (
    <PublicLayout title={`${data.studyName} — diary entry`}>
      {data.error && (
        <p
          role="alert"
          class="mb-4 rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {data.error}
        </p>
      )}
      {data.quick && items.length === 1
        ? <QuickReply item={items[0]} />
        : (
          <form method="post" class="space-y-6">
            <FormRender
              items={items}
              values={displayValues(items, data.values ?? {})}
              errors={data.errors}
            />
            <button
              type="submit"
              class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Submit entry
            </button>
          </form>
        )}
    </PublicLayout>
  );
});
