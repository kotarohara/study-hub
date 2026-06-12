import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import type { Document } from "../../../lib/db/schema.ts";
import { getDocumentFor, getVersion } from "../../../lib/objects/documents.ts";
import {
  type DiffLine,
  diffStats,
  lineDiff,
} from "../../../lib/objects/diff.ts";
import { Layout } from "../../../components/Layout.tsx";

interface Data {
  document: Document;
  from: number;
  to: number;
  diff: DiffLine[];
}

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const found = await getDocumentFor(db, ctx.state.member!, ctx.params.id);
    if (!found) throw new HttpError(404);

    const from = Number(ctx.url.searchParams.get("from"));
    const to = Number(ctx.url.searchParams.get("to"));
    const [a, b] = await Promise.all([
      getVersion(db, found.document.id, from),
      getVersion(db, found.document.id, to),
    ]);
    if (!a || !b) throw new HttpError(404);
    if (a.content === null || b.content === null) {
      throw new HttpError(409, "Diff is only available for text versions.");
    }

    return page<Data>({
      document: found.document,
      from,
      to,
      diff: lineDiff(a.content, b.content),
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => {
  const stats = diffStats(data.diff);
  return (
    <Layout
      member={state.member!}
      pathname={url.pathname}
      title={`${data.document.title}: v${data.from} → v${data.to}`}
    >
      <p class="mb-3 text-sm text-gray-600">
        <span class="text-green-700">+{stats.added}</span> /{" "}
        <span class="text-red-700">−{stats.removed}</span> lines ·{" "}
        <a
          href={`/documents/${data.document.id}?tab=versions`}
          class="text-brand-700 hover:underline"
        >
          back to versions
        </a>
      </p>
      <pre class="max-w-4xl overflow-x-auto rounded-card border border-gray-200 bg-white p-0 font-mono text-xs leading-5">
        {data.diff.map((d, i) => (
          <div
            key={i}
            class={d.type === "added"
              ? "bg-green-50 text-green-900"
              : d.type === "removed"
              ? "bg-red-50 text-red-900"
              : "text-gray-700"}
          >
            <span class="inline-block w-6 select-none px-1 text-gray-400">
              {d.type === "added" ? "+" : d.type === "removed" ? "−" : " "}
            </span>
            {d.line || " "}
          </div>
        ))}
      </pre>
    </Layout>
  );
});
