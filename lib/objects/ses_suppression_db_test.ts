// Integration tests — require the local stack: `deno task stack:up`.
// Covers the bounce suppression action wired to the SES webhook (3.4).
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  contactChannels,
  type Member,
  members,
  participants,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createParticipant, suppressEmailChannels } from "./participants.ts";

async function withEnv(fn: (env: { researcher: Member }) => Promise<void>) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `sup-res-${suffix}@studyhub.local` })])
    .returning();
  try {
    await fn({ researcher });
  } finally {
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db.delete(members).where(inArray(members.id, [researcher.id]));
    await closeTestDb();
  }
}

Deno.test("suppressEmailChannels: matches by blind index, flags, audits, no PII", async () => {
  await withEnv(async ({ researcher }) => {
    const db = await getTestDb();
    const p = await createParticipant(db, {
      name: "Ada Bounce",
      channels: [
        { kind: "email", value: "Ada@Example.com" },
        { kind: "telegram", value: "@ada" },
      ],
      createdBy: researcher,
    });

    // A hard bounce for a differently-cased address still matches (blind
    // index normalizes), and only the email channel is suppressed.
    const n = await suppressEmailChannels(db, ["ada@example.com"], {
      reason: "bounce",
    });
    assert.equal(n, 1);

    const channels = await db
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.participantId, p.id));
    const email = channels.find((c) => c.kind === "email");
    const telegram = channels.find((c) => c.kind === "telegram");
    assert.equal(email?.suppressed, true);
    assert.equal(telegram?.suppressed, false);

    // Audited without PII (reason only; no address).
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, p.id));
    const suppressed = (
      await db.select().from(auditLog).where(eq(auditLog.objectId, p.id))
    ).find((e) => e.action === "channel.suppressed");
    assert.ok(entry);
    assert.ok(suppressed);
    assert.equal(suppressed.details?.reason, "bounce");
    assert.ok(!JSON.stringify(suppressed.details).includes("ada"));

    // Re-running is a no-op (already suppressed) and an unknown address
    // matches nothing.
    assert.equal(
      await suppressEmailChannels(db, ["ada@example.com"], {
        reason: "bounce",
      }),
      0,
    );
    assert.equal(
      await suppressEmailChannels(db, ["nobody@example.com"], {
        reason: "complaint",
      }),
      0,
    );
  });
});
