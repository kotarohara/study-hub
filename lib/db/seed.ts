// Seeds the database with realistic fake data for local development.
// Idempotent: rerunning skips rows that already exist.
import { faker } from "@faker-js/faker";
import { getConfig } from "../config.ts";
import { createDb } from "./client.ts";
import { fakeMember } from "./factories.ts";
import { members } from "./schema.ts";
import { migrateDb } from "./migrate.ts";

export async function seed(databaseUrl: string): Promise<void> {
  await migrateDb(databaseUrl);
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    // Deterministic fakes so reseeding a wiped database gives the same data.
    faker.seed(42);
    const rows = [
      fakeMember({
        email: "pi@studyhub.local",
        name: "Pat Igarashi",
        role: "pi",
      }),
      fakeMember({ email: "researcher@studyhub.local", role: "researcher" }),
      fakeMember({ email: "assistant@studyhub.local", role: "assistant" }),
      fakeMember({
        email: "collaborator@studyhub.local",
        role: "collaborator",
      }),
      ...Array.from({ length: 4 }, () => fakeMember()),
    ];
    const inserted = await db
      .insert(members)
      .values(rows)
      .onConflictDoNothing()
      .returning({ email: members.email });
    console.log(`seeded ${inserted.length}/${rows.length} members`);
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
