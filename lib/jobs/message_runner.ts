// Message delivery runner (spec §3.8): the cron tick that drains the
// messages queue with retries and exponential backoff. Idempotency and
// duplicate-send prevention come from the messaging core — enqueue is
// at-most-once on idempotencyKey, and deliverMessage no-ops once a message
// is "sent", so a message selected here is never one already delivered.
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Message, messages } from "../db/schema.ts";
import type { ChannelAdapter } from "../integrations/channel.ts";
import { deliverMessage } from "../objects/messaging.ts";
import { alert } from "./alerts.ts";

/** Give up after this many attempts; the message is then permanently
 * failed and an alert fires. */
export const MAX_ATTEMPTS = 5;

/** Exponential backoff for the next retry after `attempts` failures:
 * 1m, 2m, 4m, … capped at 1h. Pure. */
export function backoffMs(attempts: number): number {
  const base = 60_000; // 1 minute
  const cap = 60 * 60_000; // 1 hour
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
}

export interface RunSummary {
  claimed: number;
  delivered: number;
  retriesScheduled: number;
  failedPermanently: number;
}

export interface RunOptions {
  now?: Date;
  limit?: number;
  maxAttempts?: number;
  /** Adapter override for tests; production resolves via the registry. */
  adapter?: ChannelAdapter;
}

/**
 * Delivers every message that is due — queued, or failed and past its
 * backoff — applying exponential backoff on failure and a permanent-failure
 * alert once attempts are exhausted. Returns a summary of the tick.
 */
export async function runDueMessages(
  db: Db,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  const due = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        inArray(messages.status, ["queued", "failed"]),
        lt(messages.attempts, maxAttempts),
        or(isNull(messages.nextAttemptAt), lte(messages.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit);

  const summary: RunSummary = {
    claimed: due.length,
    delivered: 0,
    retriesScheduled: 0,
    failedPermanently: 0,
  };

  for (const { id } of due) {
    const updated: Message = await deliverMessage(db, id, opts.adapter);
    if (updated.status === "sent") {
      summary.delivered++;
      continue;
    }
    // status === "failed"
    if (updated.attempts >= maxAttempts) {
      summary.failedPermanently++;
      await alert({
        kind: "message.delivery_failed",
        detail:
          `message ${updated.id} (${updated.channel}/${updated.templateKey}) failed after ${updated.attempts} attempts: ${updated.lastError}`,
      });
    } else {
      await db
        .update(messages)
        .set({
          nextAttemptAt: new Date(now.getTime() + backoffMs(updated.attempts)),
        })
        .where(eq(messages.id, updated.id));
      summary.retriesScheduled++;
    }
  }

  return summary;
}
