/// <reference lib="deno.unstable" />
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { runDueMessages } from "./message_runner.ts";
import { sweepDueReminders } from "../objects/notifications.ts";
import { sweepDueDiaryPrompts } from "../objects/diary.ts";

/** Drains the message queue every minute via Deno.cron (spec §3.8: no
 * external scheduler). Gated by JOBS_ENABLED and the --unstable-cron flag,
 * mirroring the backup cron so dev servers without it still boot. */
export function registerMessageCron(config: Config): boolean {
  if (!config.JOBS_ENABLED) return false;
  if (typeof Deno.cron !== "function") {
    console.warn(
      "JOBS_ENABLED is set but Deno.cron is unavailable — run with --unstable-cron",
    );
    return false;
  }
  Deno.cron("deliver due messages", "* * * * *", async () => {
    try {
      // Enqueue reminders for sessions entering the lead window first, then
      // drain the queue in the same tick. The sweep is idempotent per
      // session, so running it every minute never double-reminds.
      const swept = await sweepDueReminders(getDb());
      if (swept.enqueued > 0) {
        console.log(`reminders: enqueued ${swept.enqueued}`);
      }
      const diary = await sweepDueDiaryPrompts(getDb());
      if (diary.sent > 0 || diary.missed > 0) {
        console.log(`diary: sent ${diary.sent}, missed ${diary.missed}`);
      }
      const summary = await runDueMessages(getDb());
      if (summary.claimed > 0) {
        console.log(
          `messages: delivered ${summary.delivered}, retry ${summary.retriesScheduled}, failed ${summary.failedPermanently}`,
        );
      }
    } catch (err) {
      console.error("message runner FAILED:", err);
    }
  });
  return true;
}
