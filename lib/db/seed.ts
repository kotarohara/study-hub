// Seeds the database with realistic fake data for local development.
// Idempotent: rerunning skips rows that already exist.
import { faker } from "@faker-js/faker";
import { eq, inArray } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { hashPassword } from "../auth/password.ts";
import { createDb } from "./client.ts";
import { fakeMember } from "./factories.ts";
import { members, projectMembers, projects } from "./schema.ts";
import { migrateDb } from "./migrate.ts";

/** Every named seed account logs in with this password (dev only). */
export const SEED_PASSWORD = "studyhub-dev";

export async function seed(databaseUrl: string): Promise<void> {
  await migrateDb(databaseUrl);
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    // Deterministic fakes so reseeding a wiped database gives the same data.
    faker.seed(42);
    const passwordHash = await hashPassword(SEED_PASSWORD);
    const rows = [
      fakeMember({
        email: "pi@studyhub.local",
        name: "Pat Igarashi",
        role: "pi",
        passwordHash,
      }),
      fakeMember({
        email: "researcher@studyhub.local",
        role: "researcher",
        passwordHash,
      }),
      fakeMember({
        email: "assistant@studyhub.local",
        role: "assistant",
        passwordHash,
      }),
      fakeMember({
        email: "collaborator@studyhub.local",
        role: "collaborator",
        passwordHash,
      }),
      ...Array.from({ length: 4 }, () => fakeMember()),
    ];
    const inserted = await db
      .insert(members)
      .values(rows)
      .onConflictDoNothing()
      .returning({ email: members.email });
    console.log(`seeded ${inserted.length}/${rows.length} members`);

    // One example project owned by the PI, with the core team on it.
    const pi = (await db.query.members.findFirst({
      where: eq(members.email, "pi@studyhub.local"),
    }))!;
    const existing = await db.query.projects.findFirst({
      where: eq(projects.name, "Example Project"),
    });
    if (!existing) {
      const [project] = await db
        .insert(projects)
        .values({
          name: "Example Project",
          description:
            "Seeded sample project. Safe to archive or rename while exploring.",
          createdBy: pi.id,
        })
        .returning();
      const team = await db.query.members.findMany({
        where: inArray(members.email, [
          "pi@studyhub.local",
          "researcher@studyhub.local",
          "assistant@studyhub.local",
        ]),
      });
      await db.insert(projectMembers).values(
        team.map((m) => ({ projectId: project.id, memberId: m.id })),
      );
      console.log("seeded Example Project");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const config = getConfig();
  if (config.APP_ENV === "production") {
    console.error("refusing to seed a production database");
    Deno.exit(1);
  }
  await seed(config.DATABASE_URL);
}
