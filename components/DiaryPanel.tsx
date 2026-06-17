// "Diary" tab of the study detail view (spec §3.8): configure the ESM
// schedule (instrument + window strategy), generate prompts for active
// enrollments, and watch per-participant progress. Pseudonymous codes only.
import type { DiarySchedule, Study } from "../lib/db/schema.ts";
import type { DiaryProgressRow } from "../lib/objects/diary.ts";

const INPUT = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

interface InstrumentOption {
  id: string;
  name: string;
  currentVersion: number;
}

export function DiaryPanel(props: {
  study: Study;
  schedule: DiarySchedule | null;
  instruments: InstrumentOption[];
  progress: DiaryProgressRow[];
  canManage: boolean; // researcher+
  canOperate: boolean; // assistant+
}) {
  const { study, schedule } = props;
  return (
    <div class="space-y-8">
      {schedule
        ? (
          <ScheduleSummary
            schedule={schedule}
            instruments={props.instruments}
          />
        )
        : (
          <p class="text-sm text-gray-500">
            No diary configured yet. Set one up below to send
            experience-sampling prompts to active participants.
          </p>
        )}

      {schedule && props.canOperate && (
        <form
          method="post"
          action={`/studies/${study.id}/diary/generate`}
          class="flex items-center gap-3"
        >
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Generate prompts for active enrollments
          </button>
          <span class="text-xs text-gray-500">
            Idempotent — only enrollments without prompts get them.
          </span>
        </form>
      )}

      {schedule && <ProgressTable rows={props.progress} />}

      {props.canManage && (
        <ConfigureForm
          study={study}
          schedule={schedule}
          instruments={props.instruments}
        />
      )}
    </div>
  );
}

function ScheduleSummary(
  props: { schedule: DiarySchedule; instruments: InstrumentOption[] },
) {
  const { schedule } = props;
  const instrument = props.instruments.find((i) =>
    i.id === schedule.instrumentId
  );
  return (
    <section class="space-y-1 rounded-card border border-brand-200 bg-brand-50 p-4 text-sm">
      <h2 class="font-semibold text-gray-900">Diary schedule</h2>
      <p class="text-gray-800">
        Instrument: {instrument?.name ?? "—"}{" "}
        (v{schedule.instrumentVersionNumber})
      </p>
      <p class="text-gray-800">
        Windows: {schedule.windowType} · {describeConfig(schedule)}
      </p>
      <p class="text-gray-800">
        Runs {schedule.durationDays}{" "}
        day{schedule.durationDays === 1 ? "" : "s"}; each prompt answerable for
        {" "}
        {schedule.expiryMinutes} min
        {schedule.quickReply ? " · quick replies on" : ""}.
      </p>
    </section>
  );
}

function describeConfig(schedule: DiarySchedule): string {
  const c = schedule.config as Record<string, unknown>;
  switch (schedule.windowType) {
    case "fixed":
      return `at ${(c.times as string[] | undefined)?.join(", ") ?? "?"} UTC`;
    case "interval":
      return `every ${c.everyMinutes}m, ${c.dayStart}–${c.dayEnd} UTC`;
    case "randomized":
      return `${c.perDay}/day, ${c.dayStart}–${c.dayEnd} UTC`;
    default:
      return "";
  }
}

function ProgressTable(props: { rows: DiaryProgressRow[] }) {
  const { rows } = props;
  return (
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-gray-900">
        Progress ({rows.length})
      </h2>
      {rows.length === 0
        ? (
          <p class="text-sm text-gray-500">
            No prompts generated yet.
          </p>
        )
        : (
          <table class="w-full max-w-2xl text-sm">
            <thead>
              <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                <th class="py-2 pr-4">Participant</th>
                <th class="py-2 pr-4">Answered</th>
                <th class="py-2 pr-4">Missed</th>
                <th class="py-2 pr-4">Pending</th>
                <th class="py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.participantCode} class="border-b border-gray-100">
                  <td class="py-2 pr-4 font-medium text-gray-800">
                    {row.participantCode}
                  </td>
                  <td class="py-2 pr-4">{row.answered}</td>
                  <td class="py-2 pr-4">{row.missed}</td>
                  <td class="py-2 pr-4">{row.pending}</td>
                  <td class="py-2">{row.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  );
}

function ConfigureForm(props: {
  study: Study;
  schedule: DiarySchedule | null;
  instruments: InstrumentOption[];
}) {
  const { study, schedule, instruments } = props;
  return (
    <form
      method="post"
      action={`/studies/${study.id}/diary/configure`}
      class="max-w-2xl space-y-4 rounded-card border border-gray-200 bg-white p-4"
    >
      <h2 class="text-sm font-semibold text-gray-900">
        {schedule ? "Reconfigure diary" : "Configure diary"}
      </h2>

      {instruments.length === 0
        ? (
          <p class="text-sm text-amber-700">
            Create a simple-form instrument first — diaries ask a saved form.
          </p>
        )
        : (
          <>
            <label class="flex flex-col gap-1 text-sm">
              Diary instrument
              <select name="instrumentId" required class={INPUT}>
                {instruments.map((i) => (
                  <option
                    key={i.id}
                    value={i.id}
                    selected={schedule?.instrumentId === i.id}
                  >
                    {i.name} (v{i.currentVersion})
                  </option>
                ))}
              </select>
            </label>

            <label class="flex flex-col gap-1 text-sm">
              Window type
              <select name="windowType" class={INPUT}>
                <option
                  value="fixed"
                  selected={schedule?.windowType === "fixed"}
                >
                  Fixed times
                </option>
                <option
                  value="interval"
                  selected={schedule?.windowType === "interval"}
                >
                  Interval
                </option>
                <option
                  value="randomized"
                  selected={schedule?.windowType === "randomized"}
                >
                  Randomized
                </option>
              </select>
            </label>

            <fieldset class="space-y-2 border-t border-gray-100 pt-3">
              <legend class="text-xs uppercase tracking-wide text-gray-500">
                Fixed — daily times (comma-separated HH:MM, UTC)
              </legend>
              <input
                type="text"
                name="times"
                placeholder="09:00, 13:00, 20:00"
                class={`${INPUT} w-full`}
              />
            </fieldset>

            <fieldset class="grid grid-cols-2 gap-2 border-t border-gray-100 pt-3">
              <legend class="text-xs uppercase tracking-wide text-gray-500">
                Interval / Randomized — daily window (UTC)
              </legend>
              <label class="flex flex-col gap-1 text-sm">
                Day start
                <input
                  type="text"
                  name="dayStart"
                  placeholder="09:00"
                  class={INPUT}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Day end
                <input
                  type="text"
                  name="dayEnd"
                  placeholder="21:00"
                  class={INPUT}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Interval: every N minutes
                <input
                  type="number"
                  name="everyMinutes"
                  min={1}
                  class={INPUT}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Randomized: prompts/day
                <input type="number" name="perDay" min={1} class={INPUT} />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Randomized: min gap (min)
                <input
                  type="number"
                  name="minGapMinutes"
                  min={0}
                  class={INPUT}
                />
              </label>
            </fieldset>

            <div class="grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-1 text-sm">
                Duration (days)
                <input
                  type="number"
                  name="durationDays"
                  min={1}
                  required
                  value={schedule?.durationDays ?? 7}
                  class={INPUT}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                Prompt expiry (min)
                <input
                  type="number"
                  name="expiryMinutes"
                  min={1}
                  required
                  value={schedule?.expiryMinutes ?? 120}
                  class={INPUT}
                />
              </label>
            </div>

            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="quickReply"
                checked={schedule?.quickReply ?? false}
              />
              Enable one-tap quick replies (single-question diaries)
            </label>

            <button
              type="submit"
              class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              {schedule ? "Save changes" : "Configure diary"}
            </button>
          </>
        )}
    </form>
  );
}
