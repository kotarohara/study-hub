import { page } from "fresh";
import { define } from "../utils.ts";
import { getDb } from "../lib/db/client.ts";
import { members } from "../lib/db/schema.ts";
import { count } from "drizzle-orm";
import { Layout } from "../components/Layout.tsx";
import { NAV_ITEMS } from "../lib/ooui/nav.ts";

interface Data {
  memberCount: number;
}

export const handler = define.handlers({
  async GET() {
    const [row] = await getDb().select({ value: count() }).from(members);
    return page<Data>({ memberCount: row.value });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Dashboard">
    <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
      {NAV_ITEMS.filter((item) =>
        item.id !== "dashboard"
      ).map((item) => (
        <a
          href={item.enabled ? item.href : undefined}
          class={`rounded-card border bg-white p-4 ${
            item.enabled
              ? "border-gray-200 hover:border-brand-600"
              : "border-gray-100 opacity-50"
          }`}
        >
          <p class="text-2xl" aria-hidden="true">{item.icon}</p>
          <p class="mt-1 font-medium text-gray-900">{item.label}</p>
          <p class="text-sm text-gray-500">
            {item.id === "members"
              ? `${data.memberCount} member${data.memberCount === 1 ? "" : "s"}`
              : item.enabled
              ? ""
              : "Coming soon"}
          </p>
        </a>
      ))}
    </div>
  </Layout>
));
