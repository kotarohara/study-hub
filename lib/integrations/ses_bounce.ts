// Parsing for the SES → SNS bounce/complaint webhook (spec §3.8). Amazon
// SNS wraps the SES notification as a JSON envelope whose `Message` is
// itself a JSON string. This module is pure (no DB, no network) so it can
// be unit-tested against simulated SNS payloads; the route applies the
// result. Only PERMANENT bounces and complaints suppress an address —
// transient bounces are expected to retry.

export type SnsParsed =
  | { type: "subscription_confirmation"; subscribeUrl: string | null }
  | { type: "notification"; bounced: string[]; complained: string[] }
  | { type: "other" };

export class SnsParseError extends Error {}

function lower(emails: unknown): string[] {
  if (!Array.isArray(emails)) return [];
  return emails
    .map((e) => (typeof e === "string" ? e.trim().toLowerCase() : ""))
    .filter((e) => e.includes("@"));
}

/** Parses a raw SNS request body. Throws SnsParseError on malformed JSON. */
export function parseSnsMessage(rawBody: string): SnsParsed {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new SnsParseError("body is not valid JSON");
  }

  const snsType = envelope.Type;
  if (snsType === "SubscriptionConfirmation") {
    return {
      type: "subscription_confirmation",
      subscribeUrl: typeof envelope.SubscribeURL === "string"
        ? envelope.SubscribeURL
        : null,
    };
  }
  if (snsType !== "Notification") return { type: "other" };

  // The SES notification is a JSON string inside the SNS Message field.
  let ses: Record<string, unknown>;
  try {
    ses = typeof envelope.Message === "string"
      ? JSON.parse(envelope.Message)
      : (envelope.Message as Record<string, unknown>) ?? {};
  } catch {
    throw new SnsParseError("SNS Message is not valid JSON");
  }

  const bounced: string[] = [];
  const complained: string[] = [];

  if (ses.notificationType === "Bounce" || ses.eventType === "Bounce") {
    const bounce = (ses.bounce ?? {}) as Record<string, unknown>;
    // Only permanent (hard) bounces suppress; transient ones may recover.
    if (bounce.bounceType === "Permanent") {
      const recips = (bounce.bouncedRecipients ?? []) as Array<
        Record<string, unknown>
      >;
      bounced.push(...lower(recips.map((r) => r.emailAddress)));
    }
  }

  if (ses.notificationType === "Complaint" || ses.eventType === "Complaint") {
    const complaint = (ses.complaint ?? {}) as Record<string, unknown>;
    const recips = (complaint.complainedRecipients ?? []) as Array<
      Record<string, unknown>
    >;
    complained.push(...lower(recips.map((r) => r.emailAddress)));
  }

  return { type: "notification", bounced, complained };
}
