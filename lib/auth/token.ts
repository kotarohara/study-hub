// Opaque bearer tokens (sessions, invites): 32 random bytes, base64url.
// Only the SHA-256 hash is persisted.
import { createHash, randomBytes } from "node:crypto";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
