import assert from "node:assert/strict";
import {
  applyCollection,
  collectionHref,
  parseCollectionParams,
  sortHref,
} from "./collection.ts";

interface Row {
  name: string;
  n: number;
}

const rows: Row[] = Array.from({ length: 120 }, (_, i) => ({
  name: `row ${String(i).padStart(3, "0")}`,
  n: i,
}));

const config = {
  searchText: (r: Row) => r.name,
  sorters: { n: (a: Row, b: Row) => a.n - b.n },
  defaultSort: "n",
};

function params(over: Record<string, string> = {}) {
  return parseCollectionParams(new URLSearchParams(over));
}

Deno.test("parse: defaults and sanitization", () => {
  assert.deepEqual(params(), { q: "", sort: null, dir: "asc", page: 1 });
  assert.deepEqual(params({ page: "0" }).page, 1);
  assert.deepEqual(params({ page: "junk" }).page, 1);
  assert.deepEqual(params({ dir: "sideways" }).dir, "asc");
  assert.deepEqual(params({ q: "  x  " }).q, "x");
});

Deno.test("pagination at 50 with page clamping", () => {
  const p1 = applyCollection(rows, params(), config);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.total, 120);
  assert.equal(p1.pageCount, 3);

  const p3 = applyCollection(rows, params({ page: "3" }), config);
  assert.equal(p3.rows.length, 20);

  // Out-of-range page clamps to the last page.
  const p9 = applyCollection(rows, params({ page: "9" }), config);
  assert.equal(p9.page, 3);
});

Deno.test("filter narrows before pagination", () => {
  const result = applyCollection(rows, params({ q: "row 11" }), config);
  assert.equal(result.total, 10); // row 110–119
  assert.equal(result.pageCount, 1);
});

Deno.test("sort descending and default sort", () => {
  const desc = applyCollection(
    rows,
    params({ sort: "n", dir: "desc" }),
    config,
  );
  assert.equal(desc.rows[0].n, 119);
  const byDefault = applyCollection(rows, params(), config);
  assert.equal(byDefault.rows[0].n, 0);
});

Deno.test("hrefs roundtrip and sort toggling", () => {
  const p = params({ q: "x", sort: "n", dir: "desc", page: "2" });
  assert.equal(collectionHref("/m", p), "/m?q=x&sort=n&dir=desc&page=2");
  assert.equal(collectionHref("/m", params()), "/m");
  // Clicking the active asc column flips to desc; new column starts asc.
  assert.equal(
    sortHref("/m", params({ sort: "n" }), "n"),
    "/m?sort=n&dir=desc",
  );
  assert.equal(
    sortHref("/m", params({ sort: "n", dir: "desc" }), "n"),
    "/m?sort=n",
  );
  assert.equal(sortHref("/m", params({ sort: "n" }), "name"), "/m?sort=name");
});
