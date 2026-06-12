import assert from "node:assert/strict";
import {
  decryptField,
  DecryptionError,
  encryptField,
  EncryptionError,
  isEncrypted,
  parseKeyring,
} from "./encryption.ts";

// 32 bytes each, base64.
const KEY_V1 = "c3R1ZHlodWItZGV2LW9ubHktYWVzLWtleS0zMi1ieSE=";
const KEY_V2 = btoa("another-32-byte-key-for-rotation");
const ring = parseKeyring(`1:${KEY_V1}`);

Deno.test("encrypt/decrypt roundtrip", () => {
  for (const plaintext of ["a@b.sg", "", "名前 nâme 🙂", "+65 9123 4567"]) {
    const stored = encryptField(ring, plaintext);
    assert.ok(isEncrypted(stored));
    assert.ok(!stored.includes(plaintext) || plaintext === "");
    assert.equal(decryptField(ring, stored), plaintext);
  }
});

Deno.test("same plaintext encrypts differently every time (random IV)", () => {
  assert.notEqual(encryptField(ring, "twin"), encryptField(ring, "twin"));
});

Deno.test("tampering with any part fails authentication", () => {
  const stored = encryptField(ring, "sensitive");
  const parts = stored.split(":");
  for (const i of [2, 3, 4]) {
    const tampered = [...parts];
    const bytes = Uint8Array.from(atob(tampered[i]), (c) => c.charCodeAt(0));
    if (bytes.length === 0) continue;
    bytes[0] ^= 0xff;
    tampered[i] = btoa(String.fromCharCode(...bytes));
    assert.throws(
      () => decryptField(ring, tampered.join(":")),
      DecryptionError,
      `part ${i} tamper should fail`,
    );
  }
});

Deno.test("malformed values are rejected", () => {
  for (const bad of ["", "plaintext", "enc:v1:onlytwo", "enc:x1:a:b:c"]) {
    assert.throws(() => decryptField(ring, bad), DecryptionError);
  }
});

Deno.test("key rotation: new key encrypts, old values still decrypt", () => {
  const oldRing = parseKeyring(`1:${KEY_V1}`);
  const legacy = encryptField(oldRing, "pre-rotation");

  const rotated = parseKeyring(`1:${KEY_V1},2:${KEY_V2}`);
  assert.equal(rotated.activeVersion, 2);
  assert.equal(decryptField(rotated, legacy), "pre-rotation");
  assert.ok(encryptField(rotated, "post-rotation").startsWith("enc:v2:"));

  // A ring without the old key can no longer read legacy values.
  const v2Only = parseKeyring(`2:${KEY_V2}`);
  assert.throws(() => decryptField(v2Only, legacy), DecryptionError);
});

Deno.test("wrong key fails authentication, not garbage output", () => {
  const stored = encryptField(parseKeyring(`1:${KEY_V1}`), "secret");
  assert.throws(
    () => decryptField(parseKeyring(`1:${KEY_V2}`), stored),
    DecryptionError,
  );
});

Deno.test("keyring spec validation", () => {
  assert.throws(() => parseKeyring(""), EncryptionError);
  assert.throws(() => parseKeyring("nocolon"), EncryptionError);
  assert.throws(() => parseKeyring("0:" + KEY_V1), EncryptionError);
  assert.throws(() => parseKeyring("1:dG9vc2hvcnQ="), EncryptionError);
  assert.throws(
    () => parseKeyring(`1:${KEY_V1},1:${KEY_V2}`),
    EncryptionError,
  );
});
