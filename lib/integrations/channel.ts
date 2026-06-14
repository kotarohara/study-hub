// Channel-agnostic outbound messaging (spec §6: a ChannelAdapter interface
// keeps email/Telegram/Discord — and later WhatsApp — interchangeable). The
// messaging core (lib/objects/messaging.ts) renders and logs; an adapter
// only knows how to hand one message to its provider.
import type { MessageChannel } from "../db/schema.ts";

export type ChannelKind = MessageChannel;

export interface OutboundMessage {
  /** Address / chat id / webhook target. */
  to: string;
  /** Email subject; ignored by channels without one. */
  subject?: string;
  body: string;
}

export interface SendResult {
  ok: boolean;
  /** Provider's id for the accepted message, when available. */
  providerMessageId?: string;
  /** Short failure reason when `ok` is false (must not contain PII). */
  error?: string;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  send(message: OutboundMessage): Promise<SendResult>;
}

// Adapters register themselves at startup (email in 3.4, Telegram in 3.7,
// Discord in 3.9). The messaging core looks one up by channel when a
// caller does not inject an adapter directly.
const registry = new Map<ChannelKind, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter): void {
  registry.set(adapter.kind, adapter);
}

export function getAdapter(kind: ChannelKind): ChannelAdapter | undefined {
  return registry.get(kind);
}

/** Test/dev hook: forget all registered adapters. */
export function clearAdapters(): void {
  registry.clear();
}
