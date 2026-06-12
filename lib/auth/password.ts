// Argon2id password hashing (spec §3.10) with OWASP-recommended parameters
// (m=19456 KiB, t=2, p=1). hash-wasm is used instead of a native binding:
// the WASM core bundles cleanly in the server build and needs no
// platform-specific binaries. Output is standard $argon2id$ encoded format.
import { argon2id, argon2Verify } from "hash-wasm";

export function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    parallelism: 1,
    iterations: 2,
    memorySize: 19456,
    hashLength: 32,
    outputType: "encoded",
  });
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: passwordHash });
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
