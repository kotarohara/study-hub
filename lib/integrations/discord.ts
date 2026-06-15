// Discord webhook adapter — INTERNAL notifications only (spec §5.4: "Discord
// internal only, notifications only"). Outbound HTTP POSTs to a lab channel
// webhook; no bot, no gateway, no slash commands (all cut). Two roles:
//   1. an AlertSink for background-job/backup/delivery failures (spec §3.3,
//      "backup-failure alert to Discord");
//   2. notifyDiscordEvent for lab events (new eligible participant, session
//      booked/cancelled/no-show, milestone due, IRB expiring, payment
//      pending).
//
// INVARIANT (spec §5.4, CLAUDE.md): no PII in Discord, EVER. The DiscordEvent
// type carries only pseudonymous participant codes and internal study names —
// there is no field for a name, email, phone, or chat id. lib/integrations/
// discord_test.ts asserts payloads stay PII-free.
import { getConfig } from "../config.ts";
import type { Alert, AlertSink } from "../jobs/alerts.ts";

/** Posts a webhook payload; resolves to whether Discord accepted it. Throws
 * only on a transport failure (the caller decides whether to swallow it). */
export type DiscordTransport = (
  url: string,
  payload: DiscordPayload,
) => Promise<{ ok: boolean; status: number }>;

export interface DiscordPayload {
  content: string;
}

/** Lab events worth a channel ping. Pseudonymous by construction: `code` is a
 * participant's public code, `study` is an internal study name — never PII. */
export type DiscordEvent =
  | { kind: "enrollment_eligible"; study: string; code: string }
  | { kind: "session_booked"; study: string; code: string; at: Date }
  | { kind: "session_cancelled"; study: string; code: string; at: Date }
  | { kind: "session_no_show"; study: string; code: string; at: Date }
  | { kind: "milestone_due"; study: string; title: string; due: string }
  | { kind: "irb_expiring"; study: string; on: string }
  | { kind: "payment_pending"; study: string; code: string; amount: string };

function fmtTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The default transport: a real webhook POST. Discord returns 204 on
 * success. */
export function fetchTransport(): DiscordTransport {
  return async (url, payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Drain the body so the connection is freed.
    await res.body?.cancel();
    return { ok: res.ok, status: res.status };
  };
}

/** Renders a failure alert. Pure. */
export function formatAlert(alert: Alert): DiscordPayload {
  return { content: `🚨 **${alert.kind}** — ${alert.detail}` };
}

/** Renders a lab event. Pure; only ever interpolates pseudonymous fields. */
export function formatEvent(event: DiscordEvent): DiscordPayload {
  switch (event.kind) {
    case "enrollment_eligible":
      return {
        content: `✅ **${event.study}**: ${event.code} is eligible.`,
      };
    case "session_booked":
      return {
        content: `📅 **${event.study}**: ${event.code} booked a session for ${
          fmtTime(event.at)
        }.`,
      };
    case "session_cancelled":
      return {
        content: `❌ **${event.study}**: ${event.code} cancelled their ${
          fmtTime(event.at)
        } session.`,
      };
    case "session_no_show":
      return {
        content: `⚠️ **${event.study}**: ${event.code} did not show for the ${
          fmtTime(event.at)
        } session.`,
      };
    case "milestone_due":
      return {
        content:
          `🗓️ **${event.study}**: milestone "${event.title}" is due ${event.due}.`,
      };
    case "irb_expiring":
      return {
        content: `🛡️ **${event.study}**: IRB approval expires ${event.on}.`,
      };
    case "payment_pending":
      return {
        content:
          `💸 **${event.study}**: payment of ${event.amount} pending for ${event.code}.`,
      };
  }
}

/** Posts a payload to a webhook, swallowing transport errors (a notification
 * must never break the caller). Returns whether it was delivered. */
export async function postDiscord(
  url: string,
  payload: DiscordPayload,
  transport: DiscordTransport = fetchTransport(),
): Promise<boolean> {
  try {
    const { ok } = await transport(url, payload);
    return ok;
  } catch {
    return false;
  }
}

/** True when a Discord webhook is configured (callers can skip work when
 * notifications are off). */
export function discordConfigured(): boolean {
  return !!getConfig().DISCORD_WEBHOOK_URL;
}

/** An AlertSink that posts background-failure alerts to Discord. */
export function discordAlertSink(opts: {
  webhookUrl: string;
  transport?: DiscordTransport;
}): AlertSink {
  return {
    async notify(alert) {
      await postDiscord(opts.webhookUrl, formatAlert(alert), opts.transport);
    },
  };
}

/**
 * Fire-and-forget notification of a lab event to the configured webhook.
 * No-op when Discord is unconfigured, and never throws — safe to call
 * unawaited (`void notifyDiscordEvent(...)`) from domain code.
 */
export async function notifyDiscordEvent(
  event: DiscordEvent,
  transport?: DiscordTransport,
): Promise<void> {
  const url = getConfig().DISCORD_WEBHOOK_URL;
  if (!url) return;
  await postDiscord(url, formatEvent(event), transport);
}
