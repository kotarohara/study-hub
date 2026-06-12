// Drizzle column type for app-layer-encrypted PII (spec §6.2). Values are
// transparently encrypted on write and decrypted on read; the database only
// ever sees `enc:v<n>:...` strings. Use for every PII column on
// Participant/ContactChannel (names, emails, phone/PayNow, Telegram chat id,
// PayPal email, signatures).
//
// Kept out of schema.ts so drizzle-kit can load the schema without touching
// runtime config; the keyring is resolved lazily on first query.
import { customType } from "drizzle-orm/pg-core";
import {
  decryptField,
  encryptField,
  getKeyring,
} from "../crypto/encryption.ts";

export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => encryptField(getKeyring(), value),
  fromDriver: (value) => decryptField(getKeyring(), value),
});
