// Simple-form builder island (spec §3.4): item types, no branching.
// Edits a draft client-side and serializes it into hidden `items` /
// `scoring` JSON inputs — the surrounding route form does a normal POST
// and lib/objects/forms.ts re-validates server-side.
import { useState } from "preact/hooks";
import { ITEM_TYPES, type ItemType } from "../lib/objects/forms.ts";

interface DraftItem {
  key: string;
  prompt: string;
  type: ItemType;
  required: boolean;
  optionsText: string;
  min: string;
  max: string;
  minLabel: string;
  maxLabel: string;
}

interface DraftRule {
  key: string;
  name: string;
  aggregate: "sum" | "mean";
  items: string[];
  reverse: string[];
}

export interface FormBuilderProps {
  initialItems?: unknown[];
  initialScoring?: unknown[];
}

const TYPE_LABELS: Record<ItemType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  number: "Number",
  single_choice: "Single choice",
  multi_choice: "Multiple choice",
  likert: "Likert scale",
};

function toDraftItem(raw: unknown): DraftItem {
  const item = raw as Record<string, unknown>;
  return {
    key: String(item.key ?? ""),
    prompt: String(item.prompt ?? ""),
    type: (item.type as ItemType) ?? "short_text",
    required: Boolean(item.required),
    optionsText: Array.isArray(item.options) ? item.options.join("\n") : "",
    min: item.min === undefined ? "" : String(item.min),
    max: item.max === undefined ? "" : String(item.max),
    minLabel: String(item.minLabel ?? ""),
    maxLabel: String(item.maxLabel ?? ""),
  };
}

function toDraftRule(raw: unknown): DraftRule {
  const rule = raw as Record<string, unknown>;
  return {
    key: String(rule.key ?? ""),
    name: String(rule.name ?? ""),
    aggregate: rule.aggregate === "sum" ? "sum" : "mean",
    items: Array.isArray(rule.items) ? rule.items.map(String) : [],
    reverse: Array.isArray(rule.reverse) ? rule.reverse.map(String) : [],
  };
}

function nextKey(prefix: string, taken: string[]): string {
  for (let i = 1;; i++) {
    if (!taken.includes(`${prefix}${i}`)) return `${prefix}${i}`;
  }
}

/** Draft → the JSON shape lib/objects/forms.ts validates. */
function serializeItems(drafts: DraftItem[]): unknown[] {
  return drafts.map((d) => {
    const base = {
      key: d.key,
      prompt: d.prompt,
      type: d.type,
      required: d.required,
    };
    switch (d.type) {
      case "single_choice":
      case "multi_choice":
        return {
          ...base,
          options: d.optionsText.split("\n").map((o) => o.trim())
            .filter(Boolean),
        };
      case "number":
        return {
          ...base,
          ...(d.min.trim() !== "" ? { min: Number(d.min) } : {}),
          ...(d.max.trim() !== "" ? { max: Number(d.max) } : {}),
        };
      case "likert":
        return {
          ...base,
          min: d.min.trim() === "" ? 1 : Number(d.min),
          max: d.max.trim() === "" ? 5 : Number(d.max),
          minLabel: d.minLabel,
          maxLabel: d.maxLabel,
        };
      default:
        return base;
    }
  });
}

function serializeScoring(drafts: DraftRule[]): unknown[] {
  return drafts.map((r) => ({
    key: r.key,
    name: r.name,
    aggregate: r.aggregate,
    items: r.items,
    reverse: r.reverse.filter((k) => r.items.includes(k)),
  }));
}

const FIELD = "rounded-card border border-gray-300 px-2 py-1.5 text-sm";

export default function FormBuilder(props: FormBuilderProps) {
  const [items, setItems] = useState<DraftItem[]>(
    (props.initialItems ?? []).map(toDraftItem),
  );
  const [rules, setRules] = useState<DraftRule[]>(
    (props.initialScoring ?? []).map(toDraftRule),
  );

  const patchItem = (index: number, patch: Partial<DraftItem>) =>
    setItems(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  const moveItem = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
  };
  const removeItem = (index: number) => {
    const removed = items[index];
    setItems(items.filter((_, i) => i !== index));
    // Drop dangling references from scoring rules.
    setRules(rules.map((r) => ({
      ...r,
      items: r.items.filter((k) => k !== removed.key),
      reverse: r.reverse.filter((k) => k !== removed.key),
    })));
  };
  const addItem = (type: ItemType) =>
    setItems([
      ...items,
      {
        key: nextKey("q", items.map((i) => i.key)),
        prompt: "",
        type,
        required: false,
        optionsText: "",
        min: "",
        max: "",
        minLabel: "",
        maxLabel: "",
      },
    ]);

  const patchRule = (index: number, patch: Partial<DraftRule>) =>
    setRules(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const toggleInList = (list: string[], key: string) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  const numericItems = items.filter(
    (i) => i.type === "number" || i.type === "likert",
  );

  return (
    <div class="space-y-6">
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(serializeItems(items))}
      />
      <input
        type="hidden"
        name="scoring"
        value={JSON.stringify(serializeScoring(rules))}
      />

      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-gray-900">Items</h2>
        {items.length === 0 && (
          <p class="text-sm text-gray-500">
            No items yet — add the first question below.
          </p>
        )}
        {items.map((item, index) => (
          <div
            key={item.key}
            class="space-y-2 rounded-card border border-gray-200 bg-white p-3"
          >
            <div class="flex items-center gap-2">
              <span class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600">
                {item.key}
              </span>
              <span class="text-xs text-gray-500">
                {TYPE_LABELS[item.type]}
              </span>
              <span class="flex-1" />
              <button
                type="button"
                class="px-1 text-gray-400 hover:text-gray-700"
                title="Move up"
                onClick={() => moveItem(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                class="px-1 text-gray-400 hover:text-gray-700"
                title="Move down"
                onClick={() => moveItem(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                class="px-1 text-gray-400 hover:text-red-600"
                title="Remove item"
                onClick={() => removeItem(index)}
              >
                ✕
              </button>
            </div>
            <input
              type="text"
              placeholder="Question prompt"
              value={item.prompt}
              class={`w-full ${FIELD}`}
              onInput={(e) =>
                patchItem(index, { prompt: e.currentTarget.value })}
            />
            {(item.type === "single_choice" || item.type === "multi_choice") &&
              (
                <textarea
                  placeholder="One option per line"
                  rows={3}
                  value={item.optionsText}
                  class={`w-full ${FIELD}`}
                  onInput={(e) =>
                    patchItem(index, { optionsText: e.currentTarget.value })}
                />
              )}
            {item.type === "number" && (
              <div class="flex gap-2">
                <input
                  type="number"
                  placeholder="Min (optional)"
                  value={item.min}
                  class={FIELD}
                  onInput={(e) =>
                    patchItem(index, { min: e.currentTarget.value })}
                />
                <input
                  type="number"
                  placeholder="Max (optional)"
                  value={item.max}
                  class={FIELD}
                  onInput={(e) =>
                    patchItem(index, { max: e.currentTarget.value })}
                />
              </div>
            )}
            {item.type === "likert" && (
              <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                <input
                  type="number"
                  placeholder="Min (1)"
                  value={item.min}
                  class={FIELD}
                  onInput={(e) =>
                    patchItem(index, { min: e.currentTarget.value })}
                />
                <input
                  type="number"
                  placeholder="Max (5)"
                  value={item.max}
                  class={FIELD}
                  onInput={(e) =>
                    patchItem(index, { max: e.currentTarget.value })}
                />
                <input
                  type="text"
                  placeholder="Low label"
                  value={item.minLabel}
                  class={FIELD}
                  onInput={(e) =>
                    patchItem(index, { minLabel: e.currentTarget.value })}
                />
                <input
                  type="text"
                  placeholder="High label"
                  value={item.maxLabel}
                  class={FIELD}
                  onInput={(e) =>
                    patchItem(index, { maxLabel: e.currentTarget.value })}
                />
              </div>
            )}
            <label class="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={item.required}
                onChange={(e) =>
                  patchItem(index, { required: e.currentTarget.checked })}
              />
              Required
            </label>
          </div>
        ))}
        <div class="flex flex-wrap gap-2">
          {ITEM_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              class="rounded-card border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50"
              onClick={() => addItem(type)}
            >
              + {TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-gray-900">
          Scoring rules{" "}
          <span class="font-normal text-gray-500">
            (scales over number/likert items)
          </span>
        </h2>
        {rules.map((rule, index) => (
          <div
            key={rule.key}
            class="space-y-2 rounded-card border border-gray-200 bg-white p-3"
          >
            <div class="flex items-center gap-2">
              <input
                type="text"
                placeholder="Scale name (e.g. Satisfaction)"
                value={rule.name}
                class={`flex-1 ${FIELD}`}
                onInput={(e) =>
                  patchRule(index, { name: e.currentTarget.value })}
              />
              <select
                value={rule.aggregate}
                class={FIELD}
                onChange={(e) =>
                  patchRule(index, {
                    aggregate: e.currentTarget.value === "sum" ? "sum" : "mean",
                  })}
              >
                <option value="mean">mean</option>
                <option value="sum">sum</option>
              </select>
              <button
                type="button"
                class="px-1 text-gray-400 hover:text-red-600"
                title="Remove rule"
                onClick={() => setRules(rules.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </div>
            {numericItems.length === 0
              ? (
                <p class="text-xs text-gray-500">
                  Add number or likert items first.
                </p>
              )
              : (
                <div class="space-y-1">
                  {numericItems.map((item) => (
                    <div
                      key={item.key}
                      class="flex items-center gap-3 text-sm text-gray-700"
                    >
                      <label class="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={rule.items.includes(item.key)}
                          onChange={() =>
                            patchRule(index, {
                              items: toggleInList(rule.items, item.key),
                            })}
                        />
                        <span class="font-mono text-xs">{item.key}</span>
                        {item.prompt || "(untitled)"}
                      </label>
                      {item.type === "likert" &&
                        rule.items.includes(item.key) && (
                        <label class="flex items-center gap-1 text-xs text-gray-500">
                          <input
                            type="checkbox"
                            checked={rule.reverse.includes(item.key)}
                            onChange={() =>
                              patchRule(index, {
                                reverse: toggleInList(rule.reverse, item.key),
                              })}
                          />
                          reverse
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>
        ))}
        <button
          type="button"
          class="rounded-card border border-gray-300 px-2.5 py-1 text-xs hover:bg-gray-50"
          onClick={() =>
            setRules([
              ...rules,
              {
                key: nextKey("scale", rules.map((r) => r.key)),
                name: "",
                aggregate: "mean",
                items: [],
                reverse: [],
              },
            ])}
        >
          + Scoring rule
        </button>
      </section>
    </div>
  );
}
