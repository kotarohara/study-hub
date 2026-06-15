// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { jobs } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { resetAlertSink, setAlertSink } from "./alerts.ts";
import { runJobOnce } from "./jobs.ts";

Deno.test("runJobOnce runs once; a repeated key is skipped", async () => {
  const db = await getTestDb();
  const kind = `test-${crypto.randomUUID()}`;
  const key = `${kind}:window-1`;
  try {
    let count = 0;
    const first = await runJobOnce(db, {
      key,
      kind,
      fn: () => void count++,
    });
    assert.equal(first.ran, true);
    assert.equal(first.skipped, false);
    assert.equal(first.job?.status, "done");
    assert.equal(count, 1);

    // Same key again: the function does not run a second time.
    const second = await runJobOnce(db, {
      key,
      kind,
      fn: () => void count++,
    });
    assert.equal(second.ran, false);
    assert.equal(second.skipped, true);
    assert.equal(count, 1);
  } finally {
    await db.delete(jobs).where(eq(jobs.kind, kind));
    await closeTestDb();
  }
});

Deno.test("a throwing job is recorded failed and alerts, without propagating", async () => {
  const db = await getTestDb();
  const kind = `test-${crypto.randomUUID()}`;
  const alerts: string[] = [];
  setAlertSink({ notify: (a) => void alerts.push(a.kind) });
  try {
    const result = await runJobOnce(db, {
      key: `${kind}:boom`,
      kind,
      fn: () => {
        throw new Error("kaboom");
      },
    });
    assert.equal(result.ran, true);
    assert.equal(result.job?.status, "failed");
    assert.match(result.job?.lastError ?? "", /kaboom/);
    assert.ok(alerts.includes("job.failed"));
  } finally {
    resetAlertSink();
    await db.delete(jobs).where(eq(jobs.kind, kind));
    await closeTestDb();
  }
});
