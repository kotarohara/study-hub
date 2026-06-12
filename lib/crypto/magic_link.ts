// Signed, expiring HMAC tokens for all participant-facing pages (spec §3.10:
// participants have no accounts — magic links only). Tokens are scoped to a
// purpose so a consent link can never be replayed as, say, a booking link.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export type TokenErrorReason =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_purpose";

export class TokenError extends Error {
  constructor(public reason: TokenErrorReason) {
    super(`invalid token: ${reason}`);
  }
}

interface Payload {
  /** What the link is for, e.g. "screener", "consent", "booking", "diary". */
  p: string;
  /** Subject the link acts on (pseudonymous id — never PII). */
  s: string;
  /** Expiry, unix seconds. */
  e: number;
}

function b64url(data: Buffer): string {
  return data.toString("base64url");
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signToken(
  secret: string,
  opts: { purpose: string; subject: string; ttlSeconds: number; now?: Date },
): string {
  const now = opts.now ?? new Date();
  const payload: Payload = {
    p: opts.purpose,
    s: opts.subject,
    e: Math.floor(now.getTime() / 1000) + opts.ttlSeconds,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${b64url(hmac(secret, body))}`;
}

/**
 * Verifies signature, expiry, and purpose; returns the subject and expiry.
 * Signature is checked first so attackers learn nothing about payload
 * validity from the error reason.
 */
export function verifyToken(
  secret: string,
  token: string,
  opts: { purpose: string; now?: Date },
): { subject: string; expiresAt: Date } {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    throw new TokenError("malformed");
  }
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = hmac(secret, body);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new TokenError("bad_signature");
  }

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed");
  }
  if (
    typeof payload.p !== "string" || typeof payload.s !== "string" ||
    typeof payload.e !== "number"
  ) {
    throw new TokenError("malformed");
  }

  const now = opts.now ?? new Date();
  if (now.getTime() >= payload.e * 1000) {
    throw new TokenError("expired");
  }
  if (payload.p !== opts.purpose) {
    throw new TokenError("wrong_purpose");
  }
  return { subject: payload.s, expiresAt: new Date(payload.e * 1000) };
}
