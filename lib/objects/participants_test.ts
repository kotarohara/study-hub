// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  contactChannels,
  type Member,
  members,
  participants,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { isEncrypted } from "../crypto/encryption.ts";
import {
  addChannel,
  channelCounts,
  createParticipant,
  findDuplicates,
  listChannels,
  ParticipantError,
  removeChannel,
  setDoNotContact,
  setPreferredChannel,
  updateParticipant,
} from "./participants.ts";

async function withEnv(
  fn: (env: { assistant: Member }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [assistant] = await db
    .insert(members)
    .values([
      fakeMember({
        email: `part-asst-${suffix}@studyhub.local`,
        role: "assistant",
      }),
    ])
    .returning();
  try {
    await fn({ assistant });
  } finally {
    await db
      .delete(participants)
      .where(eq(participants.createdBy, assistant.id));
    await db.delete(members).where(eq(members.id, assistant.id));
    await closeTestDb();
  }
}

Deno.test("create: validates, generates a code, PII encrypted at rest", async () => {
  await withEnv(async ({ assistant }) => {
    const db = await getTestDb();

    await assert.rejects(
      () => createParticipant(db, { name: "   ", createdBy: assistant }),
      ParticipantError,
    );
    await assert.rejects(
      () =>
        createParticipant(db, {
          name: "Alice",
          yearOfBirth: 1850,
          createdBy: assistant,
        }),
      ParticipantError,
    );

    const alice = await createParticipant(db, {
      name: "Alice Tan",
      notes: "Prefers afternoon sessions",
      yearOfBirth: 1995,
      gender: "female",
      source: "flyer",
      channels: [
        { kind: "email", value: "Alice@Example.com" },
        { kind: "phone", value: "+65 9123 4567" },
      ],
      createdBy: assistant,
    });
    assert.match(alice.code, /^P-[0-9a-f]{8}$/);
    // Reads through Drizzle decrypt transparently.
    assert.equal(alice.name, "Alice Tan");

    // What the database actually stores must be ciphertext (spec §4).
    const raw = await db.execute<{ name: string; notes: string }>(
      sql`select name, notes from participants where id = ${alice.id}`,
    );
    assert.ok(isEncrypted(raw[0].name), `expected ciphertext: ${raw[0].name}`);
    assert.ok(!raw[0].name.includes("Alice"));
    assert.ok(isEncrypted(raw[0].notes));

    const rawChannels = await db.execute<
      { value: string; value_index: string }
    >(
      sql`select value, value_index from contact_channels
          where participant_id = ${alice.id}`,
    );
    assert.equal(rawChannels.length, 2);
    for (const row of rawChannels) {
      assert.ok(isEncrypted(row.value));
      assert.ok(!row.value.includes("alice"));
      assert.ok(!row.value.includes("9123"));
      // The blind index is opaque too.
      assert.ok(!row.value_index.toLowerCase().includes("alice"));
    }

    // Creation is audited with the pseudonymous code only — never PII.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "participant.created"),
          eq(auditLog.objectId, alice.id),
        ),
      );
    assert.ok(entry);
    assert.equal(entry.details?.code, alice.code);
    assert.ok(!JSON.stringify(entry.details).includes("Alice"));
  });
});

Deno.test("dedup: blind index matches across spelling variants, warns only", async () => {
  await withEnv(async ({ assistant }) => {
    const db = await getTestDb();
    const first = await createParticipant(db, {
      name: "Bob Lee",
      channels: [{ kind: "email", value: "bob@example.com" }],
      createdBy: assistant,
    });

    // Same address, different case and whitespace.
    const warnings = await findDuplicates(db, [
      { kind: "email", value: "  BOB@Example.COM " },
      { kind: "telegram", value: "@bob" },
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].kind, "email");
    assert.deepEqual(warnings[0].participantCodes, [first.code]);

    // The same value under a different kind is NOT a match.
    assert.equal(
      (await findDuplicates(db, [{ kind: "paypal", value: "bob@example.com" }]))
        .length,
      0,
    );

    // A participant never collides with itself when editing.
    assert.equal(
      (await findDuplicates(
        db,
        [{ kind: "email", value: "bob@example.com" }],
        first.id,
      )).length,
      0,
    );

    // Dedup warns but never blocks: creating anyway succeeds.
    const second = await createParticipant(db, {
      name: "Bobby Lee",
      channels: [{ kind: "email", value: "bob@example.com" }],
      createdBy: assistant,
    });
    const again = await findDuplicates(db, [
      { kind: "email", value: "bob@example.com" },
    ]);
    assert.deepEqual(
      again[0].participantCodes.toSorted(),
      [first.code, second.code].toSorted(),
    );
  });
});

Deno.test("update, do-not-contact and channel mutations leave an audit trail", async () => {
  await withEnv(async ({ assistant }) => {
    const db = await getTestDb();
    const p = await createParticipant(db, {
      name: "Carol Ng",
      createdBy: assistant,
    });

    await updateParticipant(db, {
      participant: p,
      name: "Carol Ng-Wong",
      gender: "female",
      actor: assistant,
    });

    const flagged = await setDoNotContact(db, {
      participant: p,
      doNotContact: true,
      actor: assistant,
    });
    assert.equal(flagged.doNotContact, true);

    const email = await addChannel(db, {
      participant: p,
      channel: { kind: "email", value: "carol@example.com" },
      actor: assistant,
    });
    const telegram = await addChannel(db, {
      participant: p,
      channel: { kind: "telegram", value: "@carol" },
      actor: assistant,
    });

    await setPreferredChannel(db, { participant: p, channelId: telegram.id });
    let channels = await listChannels(db, p.id);
    assert.deepEqual(
      channels.map((c) => [c.kind, c.isPreferred]).toSorted(),
      [["email", false], ["telegram", true]],
    );
    assert.equal((await channelCounts(db, [p.id])).get(p.id), 2);

    await removeChannel(db, {
      participant: p,
      channelId: email.id,
      actor: assistant,
    });
    channels = await listChannels(db, p.id);
    assert.equal(channels.length, 1);

    const actions = (
      await db
        .select({ action: auditLog.action, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.objectId, p.id))
    ).map((e) => e.action);
    for (
      const expected of [
        "participant.created",
        "participant.updated",
        "participant.do_not_contact_changed",
        "participant.channel_added",
        "participant.channel_removed",
      ]
    ) {
      assert.ok(actions.includes(expected), `missing audit: ${expected}`);
    }

    // No audit entry about this participant may contain PII.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, p.id));
    for (const entry of entries) {
      const dump = JSON.stringify(entry.details ?? {});
      assert.ok(!dump.includes("Carol"), `PII leaked in audit: ${dump}`);
      assert.ok(!dump.includes("carol@example.com"));
      assert.ok(!dump.includes("@carol"));
    }
  });
});

Deno.test("removeChannel ignores channels of other participants", async () => {
  await withEnv(async ({ assistant }) => {
    const db = await getTestDb();
    const a = await createParticipant(db, {
      name: "Dana",
      channels: [{ kind: "email", value: "dana@example.com" }],
      createdBy: assistant,
    });
    const b = await createParticipant(db, {
      name: "Eve",
      createdBy: assistant,
    });
    const [channel] = await listChannels(db, a.id);

    // Wrong participant: silently a no-op, channel survives.
    await removeChannel(db, {
      participant: b,
      channelId: channel.id,
      actor: assistant,
    });
    assert.equal((await listChannels(db, a.id)).length, 1);

    const channelIds = await db
      .select({ id: contactChannels.id })
      .from(contactChannels)
      .where(inArray(contactChannels.participantId, [a.id, b.id]));
    assert.equal(channelIds.length, 1);
  });
});
