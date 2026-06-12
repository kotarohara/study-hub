// App-layer AES-256-GCM field encryption for PII columns (spec §6.2).
// Synchronous on purpose (node:crypto): Drizzle custom column types require
// sync toDriver/fromDriver.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { getConfig } from "../config.ts";

export class EncryptionError extends Error {}
export class DecryptionError extends Error {}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = "enc";

/** Versioned keys: decrypt with any, encrypt with the highest version. */
export interface Keyring {
  activeVersion: number;
  keys: Map<number, Buffer>;
}

/**
 * Parses `PII_ENCRYPTION_KEYS`: comma-separated `<version>:<base64 32-byte key>`
 * pairs, e.g. `1:abc...=,2:def...=`. Rotation: add a new highest version and
 * re-encrypt at leisure; old versions stay decryptable.
 */
export function parseKeyring(spec: string): Keyring {
  const keys = new Map<number, Buffer>();
  for (const entry of spec.split(",")) {
    const sep = entry.indexOf(":");
    if (sep === -1) {
      throw new EncryptionError(
        `PII_ENCRYPTION_KEYS entry is not <version>:<base64key>: ${
          entry.slice(0, 12)
        }…`,
      );
    }
    const version = Number(entry.slice(0, sep));
    if (!Number.isInteger(version) || version < 1) {
      throw new EncryptionError(`invalid key version: ${entry.slice(0, sep)}`);
    }
    if (keys.has(version)) {
      throw new EncryptionError(`duplicate key version: ${version}`);
    }
    const key = Buffer.from(entry.slice(sep + 1), "base64");
    if (key.length !== KEY_BYTES) {
      throw new EncryptionError(
        `key v${version} must be ${KEY_BYTES} bytes after base64 decode, got ${key.length}`,
      );
    }
    keys.set(version, key);
  }
  if (keys.size === 0) {
    throw new EncryptionError("PII_ENCRYPTION_KEYS contains no keys");
  }
  return { activeVersion: Math.max(...keys.keys()), keys };
}

/** Encrypts to `enc:v<version>:<iv>:<ciphertext>:<tag>` (base64 parts). */
export function encryptField(keyring: Keyring, plaintext: string): string {
  const key = keyring.keys.get(keyring.activeVersion)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    `v${keyring.activeVersion}`,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/** Reverses {@link encryptField}; throws DecryptionError on any tampering. */
export function decryptField(keyring: Keyring, stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 5 || parts[0] !== PREFIX || !/^v\d+$/.test(parts[1])) {
    throw new DecryptionError("malformed encrypted value");
  }
  const version = Number(parts[1].slice(1));
  const key = keyring.keys.get(version);
  if (!key) {
    throw new DecryptionError(`no key for version v${version}`);
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parts[2], "base64"),
    );
    decipher.setAuthTag(Buffer.from(parts[4], "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptionError("decryption failed (tampered or wrong key)");
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:v`);
}

let cached: Keyring | undefined;

/** Process-wide keyring from `PII_ENCRYPTION_KEYS`, parsed on first use. */
export function getKeyring(): Keyring {
  cached ??= parseKeyring(getConfig().PII_ENCRYPTION_KEYS);
  return cached;
}
