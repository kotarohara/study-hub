// Server-side rendering of a simple-form instrument: read-only preview on
// instrument pages, live inputs on participant-facing pages (Phase 2.4).
// Input names are the item keys; validateResponse() consumes them as-is.
//
// Accessibility (spec §7 WCAG 2.1 AA, phase item 5.3): every input is
// programmatically labelled (aria-labelledby → the prompt), choice groups
// are real fieldsets with the prompt as legend, and validation errors are
// announced (role="alert") and associated (aria-describedby +
// aria-invalid) so screen readers land on what went wrong.
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

  const promptId = (item: FormItem) => `q-${item.key}`;
  const errorId = (item: FormItem) => `q-${item.key}-error`;
  const describedBy = (item: FormItem) =>
    errors[item.key] ? errorId(item) : undefined;

  const Prompt = ({ item }: { item: FormItem }) => (
    <p id={promptId(item)} class="text-sm font-medium text-gray-900">
      {item.prompt}
      {item.required && (
        <span class="text-red-600">
          <span aria-hidden="true">*</span>
          <span class="sr-only">(required)</span>
        </span>
      )}
    </p>
  );

  const ErrorText = ({ item }: { item: FormItem }) =>
    errors[item.key]
      ? (
        <p id={errorId(item)} role="alert" class="text-sm text-red-700">
          {errors[item.key]}
        </p>
      )
      : null;

  return (
    <ol class="space-y-5">
      {items.map((item) => (
        <li key={item.key} class="space-y-1.5">
          {item.type === "short_text" && (
            <>
              <Prompt item={item} />
              <ErrorText item={item} />
              <input
                type="text"
                name={item.key}
                disabled={disabled}
                value={String(values[item.key] ?? "")}
                aria-labelledby={promptId(item)}
                aria-describedby={describedBy(item)}
                aria-invalid={errors[item.key] ? true : undefined}
                aria-required={item.required || undefined}
                class={`w-full max-w-md ${field}`}
              />
            </>
          )}
          {item.type === "long_text" && (
            <>
              <Prompt item={item} />
              <ErrorText item={item} />
              <textarea
                name={item.key}
                rows={3}
                disabled={disabled}
                aria-labelledby={promptId(item)}
                aria-describedby={describedBy(item)}
                aria-invalid={errors[item.key] ? true : undefined}
                aria-required={item.required || undefined}
                class={`w-full max-w-md ${field}`}
              >
                {String(values[item.key] ?? "")}
              </textarea>
            </>
          )}
          {item.type === "number" && (
            <>
              <Prompt item={item} />
              <ErrorText item={item} />
              <input
                type="number"
                name={item.key}
                disabled={disabled}
                min={item.min}
                max={item.max}
                value={values[item.key] === undefined
                  ? ""
                  : String(values[item.key])}
                aria-labelledby={promptId(item)}
                aria-describedby={describedBy(item)}
                aria-invalid={errors[item.key] ? true : undefined}
                aria-required={item.required || undefined}
                class={field}
              />
            </>
          )}
          {item.type === "single_choice" && (
            <fieldset
              aria-describedby={describedBy(item)}
              class="space-y-1"
            >
              <legend class="text-sm font-medium text-gray-900">
                {item.prompt}
                {item.required && (
                  <span class="text-red-600">
                    <span aria-hidden="true">*</span>
                    <span class="sr-only">(required)</span>
                  </span>
                )}
              </legend>
              <ErrorText item={item} />
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
            </fieldset>
          )}
          {item.type === "multi_choice" && (
            <fieldset
              aria-describedby={describedBy(item)}
              class="space-y-1"
            >
              <legend class="text-sm font-medium text-gray-900">
                {item.prompt}
                {item.required && (
                  <span class="text-red-600">
                    <span aria-hidden="true">*</span>
                    <span class="sr-only">(required)</span>
                  </span>
                )}
              </legend>
              <ErrorText item={item} />
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
            </fieldset>
          )}
          {item.type === "likert" && (
            <fieldset aria-describedby={describedBy(item)}>
              <legend class="text-sm font-medium text-gray-900">
                {item.prompt}
                {item.required && (
                  <span class="text-red-600">
                    <span aria-hidden="true">*</span>
                    <span class="sr-only">(required)</span>
                  </span>
                )}
              </legend>
              <ErrorText item={item} />
              <div class="mt-1.5 flex items-center gap-3 text-sm text-gray-700">
                {item.minLabel && (
                  <span class="text-xs text-gray-500">{item.minLabel}</span>
                )}
                {Array.from(
                  { length: item.max - item.min + 1 },
                  (_, i) =>
                    item.min + i,
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
            </fieldset>
          )}
        </li>
      ))}
    </ol>
  );
}
