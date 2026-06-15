// Idempotent background-job ledger (spec §3.8, §6). `runJobOnce` claims a
// uniquely-keyed job and runs its function at most once — a second call
// with the same key (a double-fired cron, a restart mid-window) is a no-op.
// Per-message retries live on the messages table; this guards whole
// scheduled windows (e.g. "reminders:2026-06-15T10:00Z").
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Job, jobs } from "../db/schema.ts";
import { errorChainIncludes } from "../db/errors.ts";
import { alert } from "./alerts.ts";

export interface RunJobResult {
  /** True when this call executed the function (won the claim). */
  ran: boolean;
  /** True when the key already existed and the function was skipped. */
  skipped: boolean;
  job: Job | null;
}

/**
 * Runs `fn` at most once for `key`. The unique-key insert is the lock: the
 * first caller wins and runs; concurrent or later callers with the same key
 * skip. A thrown `fn` marks the job failed and fires an alert, but does not
 * propagate (a cron handler should not crash the process); the key stays
 * claimed so a failed one-shot window is not silently retried.
 */
export async function runJobOnce(
  db: Db,
  opts: { key: string; kind: string; fn: () => Promise<void> | void },
): Promise<RunJobResult> {
  let claimed: Job;
  try {
    [claimed] = await db
      .insert(jobs)
      .values({
        key: opts.key,
        kind: opts.kind,
        status: "running",
        attempts: 1,
      })
      .returning();
  } catch (err) {
    if (errorChainIncludes(err, "jobs_key_unique")) {
      const existing = await db.query.jobs.findFirst({
        where: eq(jobs.key, opts.key),
      });
      return { ran: false, skipped: true, job: existing ?? null };
    }
    throw err;
  }

  try {
    await opts.fn();
    const [done] = await db
      .update(jobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(jobs.id, claimed.id))
      .returning();
    return { ran: true, skipped: false, job: done };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [failed] = await db
      .update(jobs)
      .set({ status: "failed", lastError: message, finishedAt: new Date() })
      .where(eq(jobs.id, claimed.id))
      .returning();
    await alert({
      kind: "job.failed",
      detail: `${opts.kind} (${opts.key}): ${message}`,
    });
    return { ran: true, skipped: false, job: failed };
  }
}
