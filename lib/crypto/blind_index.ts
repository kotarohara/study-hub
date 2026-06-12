// Blind index for encrypted PII (deduplication + lookup): encrypted
// columns use random IVs, so equality must go through a deterministic
// keyed HMAC of the normalized value. The index key must never rotate
// without re-indexing (unlike the encryption keyring).
import { createHmac } from "node:crypto";
import type { ContactChannelKind } from "../db/schema.ts";

/** Normalization per channel kind so trivially-different spellings of the
 * same address collide in the index. */
export function normalizeChannelValue(
  kind: ContactChannelKind,
  value: string,
): string {
  const trimmed = value.trim();
  switch (kind) {
    case "email":
    case "paypal":
      return trimmed.toLowerCase();
    case "phone":
      return trimmed.replaceAll(/[\s\-()]/g, "");
    case "telegram":
    case "prolific":
      return trimmed;
  }
}

export function blindIndex(secret: string, normalized: string): string {
  return createHmac("sha256", secret).update(normalized).digest("base64url");
}

export function channelIndex(
  secret: string,
  kind: ContactChannelKind,
  value: string,
): string {
  return blindIndex(secret, `${kind}:${normalizeChannelValue(kind, value)}`);
}
