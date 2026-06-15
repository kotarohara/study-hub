// Pure-logic tests — no stack, no network. Simulated SNS payloads.
import assert from "node:assert/strict";
import { parseSnsMessage, SnsParseError } from "./ses_bounce.ts";

Deno.test("SubscriptionConfirmation is recognized with its SubscribeURL", () => {
  const parsed = parseSnsMessage(JSON.stringify({
    Type: "SubscriptionConfirmation",
    SubscribeURL: "https://sns.example/confirm?x=1",
  }));
  assert.equal(parsed.type, "subscription_confirmation");
  if (parsed.type === "subscription_confirmation") {
    assert.equal(parsed.subscribeUrl, "https://sns.example/confirm?x=1");
  }
});

Deno.test("permanent bounce yields the bounced addresses, lowercased", () => {
  const sesMessage = JSON.stringify({
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [
        { emailAddress: "Ada@Example.com" },
        { emailAddress: "bo@example.com" },
      ],
    },
  });
  const parsed = parseSnsMessage(JSON.stringify({
    Type: "Notification",
    Message: sesMessage,
  }));
  assert.equal(parsed.type, "notification");
  if (parsed.type === "notification") {
    assert.deepEqual(parsed.bounced, ["ada@example.com", "bo@example.com"]);
    assert.deepEqual(parsed.complained, []);
  }
});

Deno.test("transient bounce suppresses nothing", () => {
  const parsed = parseSnsMessage(JSON.stringify({
    Type: "Notification",
    Message: JSON.stringify({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "temp@example.com" }],
      },
    }),
  }));
  assert.equal(parsed.type, "notification");
  if (parsed.type === "notification") assert.deepEqual(parsed.bounced, []);
});

Deno.test("complaint yields the complained addresses", () => {
  const parsed = parseSnsMessage(JSON.stringify({
    Type: "Notification",
    Message: JSON.stringify({
      notificationType: "Complaint",
      complaint: {
        complainedRecipients: [{ emailAddress: "angry@example.com" }],
      },
    }),
  }));
  assert.equal(parsed.type, "notification");
  if (parsed.type === "notification") {
    assert.deepEqual(parsed.complained, ["angry@example.com"]);
  }
});

Deno.test("malformed JSON and non-notification types are handled", () => {
  assert.throws(() => parseSnsMessage("not json"), SnsParseError);
  assert.throws(
    () =>
      parseSnsMessage(JSON.stringify({ Type: "Notification", Message: "{" })),
    SnsParseError,
  );
  assert.equal(
    parseSnsMessage(JSON.stringify({ Type: "Whatever" })).type,
    "other",
  );
});
