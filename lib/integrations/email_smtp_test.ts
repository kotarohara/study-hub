// Integration test — requires the local stack (Mailpit). Exercises the
// hand-rolled SMTP client end to end against Mailpit and verifies receipt
// through Mailpit's HTTP API. No external network.
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { EmailAdapter } from "./email.ts";

const MAILPIT = "http://localhost:8025";

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

Deno.test("EmailAdapter delivers to Mailpit over SMTP", async () => {
  const adapter = new EmailAdapter(loadConfig({}));
  const marker = crypto.randomUUID();
  const subject = `StudyHub test ${marker}`;

  const result = await adapter.send({
    to: "ada@example.com",
    subject,
    body: `Hello from the SMTP integration test (${marker}).`,
  });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.providerMessageId);

  // Poll Mailpit for the message (delivery is near-instant locally).
  let found: MailpitMessage | undefined;
  for (let attempt = 0; attempt < 20 && !found; attempt++) {
    const res = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(subject)}`,
    );
    const data = await res.json() as { messages: MailpitMessage[] };
    found = data.messages.find((m) => m.Subject === subject);
    if (!found) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(found, "message did not arrive in Mailpit");
  assert.equal(found.To[0].Address, "ada@example.com");

  // The base64 body decodes back to our text on the server.
  const detail = await (await fetch(`${MAILPIT}/api/v1/message/${found.ID}`))
    .json() as { Text: string };
  assert.ok(detail.Text.includes(marker));

  // Clean up just this message.
  await fetch(`${MAILPIT}/api/v1/messages`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ IDs: [found.ID] }),
  });
});
