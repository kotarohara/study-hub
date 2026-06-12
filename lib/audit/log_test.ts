// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { auditLog } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { audit } from "./log.ts";

function expectAppendOnly(err: unknown): boolean {
  let cur: unknown = err;
  while (cur instanceof Error) {
    if (cur.message.includes("append-only")) return true;
    cur = cur.cause;
  }
  throw new Error(`expected append-only rejection, got: ${err}`);
}

Deno.test("audit: write helper records all fields", async (t) => {
  const db = await getTestDb();
  const requestId = crypto.randomUUID();
  try {
    await audit(db, {
      action: "test.event",
      actorId: null,
      objectType: "widget",
      objectId: "w-1",
      details: { reason: "integration test", count: 2 },
      requestId,
      ip: "127.0.0.1",
    });
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    assert.equal(entry.action, "test.event");
    assert.equal(entry.actorId, null);
    assert.equal(entry.objectType, "widget");
    assert.equal(entry.objectId, "w-1");
    assert.deepEqual(entry.details, { reason: "integration test", count: 2 });
    assert.equal(entry.ip, "127.0.0.1");
    assert.ok(entry.at instanceof Date);
  } finally {
    await t.step("close", closeTestDb);
  }
});

Deno.test("audit: UPDATE, DELETE and TRUNCATE are rejected by the database", async (t) => {
  const db = await getTestDb();
  const requestId = crypto.randomUUID();
  try {
    await audit(db, { action: "test.immutable", requestId });

    await assert.rejects(
      () =>
        db
          .update(auditLog)
          .set({ action: "tampered" })
          .where(eq(auditLog.requestId, requestId)),
      expectAppendOnly,
    );
    await assert.rejects(
      () => db.delete(auditLog).where(eq(auditLog.requestId, requestId)),
      expectAppendOnly,
    );
    await assert.rejects(
      () => db.execute(sql`truncate table audit_log`),
      expectAppendOnly,
    );
    // Raw SQL is equally blocked — enforcement is in the database.
    await assert.rejects(
      () =>
        db.execute(
          sql`update audit_log set action = 'tampered' where request_id = ${requestId}`,
        ),
      expectAppendOnly,
    );

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    assert.equal(entry.action, "test.immutable");
  } finally {
    await t.step("close", closeTestDb);
  }
});
