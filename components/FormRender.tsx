// Server-side rendering of a simple-form instrument: read-only preview on
// instrument pages, live inputs on participant-facing pages (Phase 2.4).
// Input names are the item keys; validateResponse() consumes them as-is.
import type { Answers, FormItem } from "../lib/objects/forms.ts";

export function FormRender(props: {
  items: FormItem[];
  /** Preview mode: render inputs but accept no input. */
  disabled?: boolean;
  values?: Answers;
  errors?: Record<string, string>;
}) {
  const { items, disabled } = props;
  const values = props.values ?? {};
  const errors = props.errors ?? {};
  const field =
    "rounded-card border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50";

  return (
    <ol class="space-y-5">
      {items.map((item) => (
        <li key={item.key} class="space-y-1.5">
          <p class="text-sm font-medium text-gray-900">
            {item.prompt}
            {item.required && <span class="text-red-600">*</span>}
          </p>
          {errors[item.key] && (
            <p class="text-sm text-red-700">{errors[item.key]}</p>
          )}

          {item.type === "short_text" && (
            <input
              type="text"
              name={item.key}
              disabled={disabled}
              value={String(values[item.key] ?? "")}
              class={`w-full max-w-md ${field}`}
            />
          )}
          {item.type === "long_text" && (
            <textarea
              name={item.key}
              rows={3}
              disabled={disabled}
              class={`w-full max-w-md ${field}`}
            >
              {String(values[item.key] ?? "")}
            </textarea>
          )}
          {item.type === "number" && (
            <input
              type="number"
              name={item.key}
              disabled={disabled}
              min={item.min}
              max={item.max}
              value={values[item.key] === undefined
                ? ""
                : String(values[item.key])}
              class={field}
            />
          )}
          {item.type === "single_choice" && (
            <div class="space-y-1">
              {item.options.map((option) => (
                <label
                  key={option}
                  class="flex items-center gap-2 text-sm text-gray-800"
                >
                  <input
                    type="radio"
                    name={item.key}
                    value={option}
                    disabled={disabled}
                    checked={values[item.key] === option}
                  />
                  {option}
                </label>
              ))}
            </div>
          )}
          {item.type === "multi_choice" && (
            <div class="space-y-1">
              {item.options.map((option) => (
                <label
                  key={option}
                  class="flex items-center gap-2 text-sm text-gray-800"
                >
                  <input
                    type="checkbox"
                    name={item.key}
                    value={option}
                    disabled={disabled}
                    checked={Array.isArray(values[item.key]) &&
                      (values[item.key] as string[]).includes(option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          )}
          {item.type === "likert" && (
            <div class="flex items-center gap-3 text-sm text-gray-700">
              {item.minLabel && (
                <span class="text-xs text-gray-500">{item.minLabel}</span>
              )}
              {Array.from(
                { length: item.max - item.min + 1 },
                (_, i) => item.min + i,
              ).map((point) => (
                <label
                  key={point}
                  class="flex flex-col items-center gap-1 text-xs"
                >
                  <input
                    type="radio"
                    name={item.key}
                    value={point}
                    disabled={disabled}
                    checked={values[item.key] === point}
                  />
                  {point}
                </label>
              ))}
              {item.maxLabel && (
                <span class="text-xs text-gray-500">{item.maxLabel}</span>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
