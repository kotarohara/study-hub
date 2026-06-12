// Argon2id password hashing (spec §3.10). @node-rs/argon2 defaults follow
// the OWASP recommendation (m=19456 KiB, t=2, p=1).
import { hash, verify } from "@node-rs/argon2";

const ARGON2ID = 2;

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID });
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash (e.g. member has no password yet).
    return false;
  }
}

export const MIN_PASSWORD_LENGTH = 10;

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
