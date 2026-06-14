// Email channel adapter (spec §3.8, §6). Builds an RFC 5322 message and
// hands it to the SMTP client — the same code path for Mailpit in dev and
// SES SMTP in production, differing only by config (auth ⇒ STARTTLS+AUTH).
import type { Config } from "../config.ts";
import type {
  ChannelAdapter,
  ChannelKind,
  OutboundMessage,
  SendResult,
} from "./channel.ts";
import { sendSmtp } from "./smtp.ts";

const CRLF = "\r\n";

/** Bare address out of a "Name <addr>" header, else the trimmed input. */
export function addressOnly(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

function needsEncoding(value: string): boolean {
  // deno-lint-ignore no-control-regex
  return /[^\x00-\x7F]/.test(value);
}

/** RFC 2047 encoded-word for non-ASCII header values (e.g. subjects). */
export function encodeHeaderWord(value: string): string {
  if (!needsEncoding(value)) return value;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  return `=?UTF-8?B?${b64}?=`;
}

/** Wraps base64 to 76-character lines (RFC 2045). */
function wrap76(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

export interface EmailInput {
  /** Full From header value, e.g. "StudyHub <noreply@…>". */
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  date?: Date;
}

/** Builds a complete text/plain message with a base64 body (CRLF endings). */
export function buildEmail(input: EmailInput): string {
  const bodyB64 = wrap76(
    btoa(String.fromCharCode(...new TextEncoder().encode(input.body))),
  );
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return headers.join(CRLF) + CRLF + CRLF + bodyB64;
}

export class EmailAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = "email";
  #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const messageId = `<${crypto.randomUUID()}@studyhub>`;
    try {
      const raw = buildEmail({
        from: this.#config.MAIL_FROM,
        to: message.to,
        subject: message.subject ?? "(no subject)",
        body: message.body,
        messageId,
      });
      await sendSmtp({
        host: this.#config.SMTP_HOST,
        port: this.#config.SMTP_PORT,
        username: this.#config.SMTP_USERNAME || undefined,
        password: this.#config.SMTP_PASSWORD || undefined,
      }, {
        from: addressOnly(this.#config.MAIL_FROM),
        to: message.to,
        raw,
      });
      return { ok: true, providerMessageId: messageId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "send failed",
      };
    }
  }
}
