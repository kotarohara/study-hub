// Collection view (spec §2.2 #2): filterable/sortable table with pagination
// at 50 and an optional bulk-action slot. Server-rendered; all interaction
// is links + GET forms, so no island is needed.
import type { ComponentChildren } from "preact";
import {
  collectionHref,
  type CollectionResult,
  sortHref,
} from "../../lib/ooui/collection.ts";

export interface Column<T> {
  id: string;
  label: string;
  sortable?: boolean;
  render: (row: T) => ComponentChildren;
}

export interface BulkAction {
  id: string;
  label: string;
  /** POST target; selected row ids are submitted as `ids`. */
  href: string;
  confirm?: string;
}

export function CollectionView<T>(props: {
  baseHref: string;
  columns: Column<T>[];
  result: CollectionResult<T>;
  rowId: (row: T) => string;
  rowHref?: (row: T) => string;
  emptyMessage?: string;
  searchPlaceholder?: string;
  /** Collection-level actions (e.g. "Invite member"), rendered by the box. */
  toolbar?: ComponentChildren;
  bulkActions?: BulkAction[];
}) {
  const { result } = props;
  const { params } = result;
  const hasBulk = (props.bulkActions?.length ?? 0) > 0;
  const formId = "bulk-form";

  const table = (
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
          {hasBulk && <th class="w-8 px-3 py-2" />}
          {props.columns.map((col) => (
            <th class="px-3 py-2 font-medium">
              {col.sortable
                ? (
                  <a
                    href={sortHref(props.baseHref, params, col.id)}
                    class="hover:text-gray-900"
                  >
                    {col.label}
                    {params.sort === col.id && (
                      <span aria-hidden="true">
                        {params.dir === "asc" ? " ↑" : " ↓"}
                      </span>
                    )}
                  </a>
                )
                : col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row) => (
          <tr class="border-b border-gray-100 hover:bg-gray-50">
            {hasBulk && (
              <td class="px-3 py-2">
                <input
                  type="checkbox"
                  name="ids"
                  value={props.rowId(row)}
                  form={formId}
                />
              </td>
            )}
            {props.columns.map((col, i) => (
              <td class="px-3 py-2">
                {i === 0 && props.rowHref
                  ? (
                    <a
                      href={props.rowHref(row)}
                      class="font-medium text-brand-700 hover:underline"
                    >
                      {col.render(row)}
                    </a>
                  )
                  : col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <section class="rounded-card border border-gray-200 bg-white">
      <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 p-3">
        <form
          method="get"
          action={props.baseHref}
          class="flex items-center gap-2"
        >
          {params.sort && (
            <input type="hidden" name="sort" value={params.sort} />
          )}
          {params.dir !== "asc" && (
            <input type="hidden" name="dir" value={params.dir} />
          )}
          <input
            type="search"
            name="q"
            value={params.q}
            placeholder={props.searchPlaceholder ?? "Filter…"}
            class="w-64 rounded-card border border-gray-300 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            class="rounded-card border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Filter
          </button>
        </form>
        <div class="ml-auto flex items-center gap-2">{props.toolbar}</div>
      </div>

      {hasBulk && (
        <div class="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2">
          <span class="text-xs text-gray-500">With selected:</span>
          {props.bulkActions!.map((action) => (
            <form
              method="post"
              action={action.href}
              id={formId}
              class="inline"
              data-confirm={action.confirm}
            >
              <button
                type="submit"
                class="rounded-card border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-100"
              >
                {action.label}
              </button>
            </form>
          ))}
        </div>
      )}

      {result.total === 0
        ? (
          <p class="p-8 text-center text-sm text-gray-500">
            {props.emptyMessage ?? "Nothing here yet."}
          </p>
        )
        : table}

      <div class="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs text-gray-500">
        <span>
          {result.total === 0 ? "0" : (result.page - 1) * 50 + 1}–
          {Math.min(result.page * 50, result.total)} of {result.total}
        </span>
        <span class="flex gap-2">
          {result.page > 1 && (
            <a
              href={collectionHref(props.baseHref, params, {
                page: result.page - 1,
              })}
              class="text-brand-700 hover:underline"
            >
              ← Previous
            </a>
          )}
          {result.page < result.pageCount && (
            <a
              href={collectionHref(props.baseHref, params, {
                page: result.page + 1,
              })}
              class="text-brand-700 hover:underline"
            >
              Next →
            </a>
          )}
        </span>
      </div>
    </section>
  );
}
