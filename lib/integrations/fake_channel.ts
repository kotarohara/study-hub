// In-memory channel adapter for local development and tests — no network.
// It records every message it is asked to send so tests can assert on the
// outbound traffic, and can be told to fail to exercise retry paths. The
// real adapters (SMTP/SES, Telegram, Discord) arrive in later phases.
import type {
  ChannelAdapter,
  ChannelKind,
  OutboundMessage,
  SendResult,
} from "./channel.ts";

export class FakeAdapter implements ChannelAdapter {
  readonly kind: ChannelKind;
  readonly sent: OutboundMessage[] = [];
  /** When set, send() returns this failure instead of recording success. */
  failWith: string | null = null;

  constructor(kind: ChannelKind = "email") {
    this.kind = kind;
  }

  // deno-lint-ignore require-await
  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.failWith) return { ok: false, error: this.failWith };
    this.sent.push(message);
    return { ok: true, providerMessageId: `fake-${this.sent.length}` };
  }
}
