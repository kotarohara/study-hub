// Collection-view helpers (spec §2.2 #2): filter, sort, paginate at 50.
// In-memory for now (lab-scale row counts); push down to SQL when a
// collection outgrows it.

export const PAGE_SIZE = 50;

export interface CollectionParams {
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  page: number;
}

export interface CollectionResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
  params: CollectionParams;
}

export interface CollectionConfig<T> {
  /** Text matched (case-insensitive) against the filter box. */
  searchText?: (row: T) => string;
  /** Comparators by sort key (ascending). */
  sorters?: Record<string, (a: T, b: T) => number>;
  defaultSort?: string;
  pageSize?: number;
}

export function parseCollectionParams(sp: URLSearchParams): CollectionParams {
  const page = Number(sp.get("page"));
  return {
    q: sp.get("q")?.trim() ?? "",
    sort: sp.get("sort"),
    dir: sp.get("dir") === "desc" ? "desc" : "asc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function applyCollection<T>(
  all: T[],
  params: CollectionParams,
  config: CollectionConfig<T> = {},
): CollectionResult<T> {
  let rows = all;

  if (params.q && config.searchText) {
    const needle = params.q.toLowerCase();
    rows = rows.filter((row) =>
      config.searchText!(row).toLowerCase().includes(needle)
    );
  }

  const sortKey = params.sort ?? config.defaultSort ?? null;
  const sorter = sortKey ? config.sorters?.[sortKey] : undefined;
  if (sorter) {
    rows = [...rows].sort(sorter);
    if (params.dir === "desc") rows.reverse();
  }

  const pageSize = config.pageSize ?? PAGE_SIZE;
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(params.page, pageCount);

  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageCount,
    params: { ...params, sort: sortKey, page },
  };
}

/** Href for the same collection with some params changed. */
export function collectionHref(
  base: string,
  params: CollectionParams,
  overrides: Partial<CollectionParams> = {},
): string {
  const merged = { ...params, ...overrides };
  const sp = new URLSearchParams();
  if (merged.q) sp.set("q", merged.q);
  if (merged.sort) sp.set("sort", merged.sort);
  if (merged.dir !== "asc") sp.set("dir", merged.dir);
  if (merged.page !== 1) sp.set("page", String(merged.page));
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Header link target: clicking a sorted column toggles direction. */
export function sortHref(
  base: string,
  params: CollectionParams,
  column: string,
): string {
  const dir = params.sort === column && params.dir === "asc" ? "desc" : "asc";
  return collectionHref(base, params, { sort: column, dir, page: 1 });
}
