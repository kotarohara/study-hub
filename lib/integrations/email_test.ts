// Pure-logic tests — no stack, no network.
import assert from "node:assert/strict";
import { addressOnly, buildEmail, encodeHeaderWord } from "./email.ts";

Deno.test("addressOnly: extracts the bare address from a display form", () => {
  assert.equal(
    addressOnly("StudyHub <noreply@studyhub.org>"),
    "noreply@studyhub.org",
  );
  assert.equal(addressOnly("plain@studyhub.org"), "plain@studyhub.org");
});

Deno.test("encodeHeaderWord: ASCII untouched, non-ASCII MIME-encoded", () => {
  assert.equal(
    encodeHeaderWord("Your session is booked"),
    "Your session is booked",
  );
  const encoded = encodeHeaderWord("Café réservé");
  assert.ok(encoded.startsWith("=?UTF-8?B?") && encoded.endsWith("?="));
  // Round-trips back to the original text.
  const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
  assert.equal(
    new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    ),
    "Café réservé",
  );
});

Deno.test("buildEmail: headers present, base64 body decodes to the original", () => {
  const raw = buildEmail({
    from: "StudyHub <noreply@studyhub.org>",
    to: "ada@example.com",
    subject: "Hello",
    body: "Hi Ada,\nYour session is booked.\n",
    messageId: "<abc@studyhub>",
    date: new Date("2026-06-01T00:00:00Z"),
  });

  const [head, body] = raw.split("\r\n\r\n");
  assert.ok(head.includes("From: StudyHub <noreply@studyhub.org>"));
  assert.ok(head.includes("To: ada@example.com"));
  assert.ok(head.includes("Subject: Hello"));
  assert.ok(head.includes("Message-ID: <abc@studyhub>"));
  assert.ok(head.includes("Content-Transfer-Encoding: base64"));
  // Body decodes back to the source text.
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(body.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)),
  );
  assert.equal(decoded, "Hi Ada,\nYour session is booked.\n");
});

Deno.test("buildEmail: long body wraps base64 to ≤76-char lines", () => {
  const raw = buildEmail({
    from: "x@y.z",
    to: "a@b.c",
    subject: "S",
    body: "y".repeat(500),
    messageId: "<m@studyhub>",
  });
  const body = raw.split("\r\n\r\n")[1];
  for (const ln of body.split("\r\n")) assert.ok(ln.length <= 76);
});
