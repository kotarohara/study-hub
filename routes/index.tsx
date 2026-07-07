// Home dashboard (spec §5.2 health view): recruiting funnel vs target N
// for live studies, the coming week's sessions, and overdue milestones —
// plus the object-collection tiles. Pseudonymous codes only.
import { page } from "fresh";
import { define } from "../utils.ts";
import { getDb } from "../lib/db/client.ts";
import { members } from "../lib/db/schema.ts";
import { count } from "drizzle-orm";
import { Layout } from "../components/Layout.tsx";
import { NAV_ITEMS } from "../lib/ooui/nav.ts";
import { listProjectsFor } from "../lib/objects/projects.ts";
import { type HealthSnapshot, healthSnapshot } from "../lib/objects/health.ts";
import { StatusBadge } from "../components/ooui/StatusBadge.tsx";

interface Data {
  memberCount: number;
  projectCount: number;
  health: HealthSnapshot;
}

export const handler = define.handlers({
  async GET(ctx) {
    const db = getDb();
    const [row] = await db.select({ value: count() }).from(members);
    const visible = await listProjectsFor(db, ctx.state.member!);
    return page<Data>({
      memberCount: row.value,
      projectCount: visible.length,
      health: await healthSnapshot(db, ctx.state.member!),
    });
  },
});

function fmtWhen(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default define.page<typeof handler>(({ data, state, url }) => {
  const { health } = data;
  return (
    <Layout member={state.member!} pathname={url.pathname} title="Dashboard">
      {(health.progress.length > 0 || health.overdue.length > 0 ||
        health.upcoming.length > 0) && (
        <div class="mb-8 grid gap-6 lg:grid-cols-3">
          <section class="space-y-3">
            <h2 class="text-sm font-semibold text-gray-900">
              Recruiting progress
            </h2>
            {health.progress.length === 0
              ? <p class="text-sm text-gray-500">No live studies.</p>
              : health.progress.map((study) => {
                const percent = study.target
                  ? Math.min(100, (study.enrolled / study.target) * 100)
                  : null;
                return (
                  <div
                    key={study.studyId}
                    class="rounded-card border border-gray-200 bg-white p-3"
                  >
                    <div class="flex items-center justify-between gap-2 text-sm">
                      <a
                        href={`/studies/${study.studyId}?tab=recruitment`}
                        class="font-medium text-brand-700 hover:underline"
                      >
                        {study.studyName}
                      </a>
                      <StatusBadge status={study.status} />
                    </div>
                    <p class="mt-1 text-sm text-gray-700">
                      {study.enrolled}
                      {study.target !== null && ` / ${study.target}`} enrolled
                    </p>
                    {percent !== null && (
                      <div
                        class="mt-1.5 h-2 rounded-full bg-gray-100"
                        role="progressbar"
                        aria-valuenow={study.enrolled}
                        aria-valuemin={0}
                        aria-valuemax={study.target ?? undefined}
                        aria-label={`${study.studyName} recruiting progress`}
                      >
                        <div
                          class="h-2 rounded-full bg-brand-600"
                          style={`width: ${percent}%`}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
          </section>

          <section class="space-y-3">
            <h2 class="text-sm font-semibold text-gray-900">
              Sessions this week
            </h2>
            {health.upcoming.length === 0
              ? <p class="text-sm text-gray-500">Nothing scheduled.</p>
              : (
                <ul class="space-y-1.5">
                  {health.upcoming.map((session) => (
                    <li
                      key={session.sessionId}
                      class="rounded-card border border-gray-200 bg-white px-3 py-2 text-sm"
                    >
                      <span class="font-medium text-gray-800">
                        {session.participantCode ?? "—"}
                      </span>{" "}
                      · {fmtWhen(session.startsAt)}
                      {session.location && ` · ${session.location}`}
                      <span class="text-gray-500">
                        {" "}— {session.studyName}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section class="space-y-3">
            <h2 class="text-sm font-semibold text-gray-900">
              Overdue milestones
            </h2>
            {health.overdue.length === 0
              ? <p class="text-sm text-gray-500">Nothing overdue. 🎉</p>
              : (
                <ul class="space-y-1.5">
                  {health.overdue.map((item) => (
                    <li
                      key={item.milestoneId}
                      class="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                    >
                      <span class="font-medium">{item.title}</span> — due{" "}
                      {item.dueOn.toISOString().slice(0, 10)}
                      {item.studyId && item.studyName && (
                        <>
                          {" "}·{" "}
                          <a
                            href={`/studies/${item.studyId}?tab=timeline`}
                            class="text-brand-700 hover:underline"
                          >
                            {item.studyName}
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
      )}

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
                ? `${data.memberCount} member${
                  data.memberCount === 1 ? "" : "s"
                }`
                : item.id === "projects"
                ? `${data.projectCount} project${
                  data.projectCount === 1 ? "" : "s"
                }`
                : item.enabled
                ? ""
                : "Coming soon"}
            </p>
          </a>
        ))}
      </div>
    </Layout>
  );
});
