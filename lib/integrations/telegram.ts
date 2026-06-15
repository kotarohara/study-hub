// Telegram channel adapter (spec §3.8, §6). Sends a message to a chat via
// the Bot API `sendMessage` method; `to` is the chat id captured at pairing
// (Telegram has no subject, so it is ignored). The HTTP call goes through an
// injectable transport so tests exercise the full adapter with simulated Bot
// API responses and no network — there is no local Telegram to point at the
// way Mailpit stands in for SMTP.
import type {
  ChannelAdapter,
  ChannelKind,
  OutboundMessage,
  SendResult,
} from "./channel.ts";

/** A Bot API response envelope (the fields we read). */
export interface TelegramResponse {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
  error_code?: number;
}

/** Calls a Bot API method with a JSON payload and returns the parsed
 * response. Throws on a transport/HTTP failure (the adapter turns that into
 * a retryable SendResult). */
export type TelegramTransport = (
  method: string,
  payload: Record<string, unknown>,
) => Promise<TelegramResponse>;

const API_BASE = "https://api.telegram.org";

/** The default transport: a real Bot API call over HTTPS. */
export function fetchTransport(botToken: string): TelegramTransport {
  return async (method, payload) => {
    const res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Bot API returns a JSON envelope on both success and logical failure
    // (e.g. 403 blocked); a non-JSON body is a genuine transport problem.
    let json: TelegramResponse;
    try {
      json = await res.json() as TelegramResponse;
    } catch {
      throw new Error(`Telegram ${method} returned non-JSON (${res.status})`);
    }
    return json;
  };
}

/** Maps a Bot API envelope to a SendResult. The `description` is the API's
 * own short error text (no PII). Pure. */
export function toSendResult(response: TelegramResponse): SendResult {
  if (response.ok) {
    const id = response.result?.message_id;
    return {
      ok: true,
      providerMessageId: id !== undefined ? String(id) : undefined,
    };
  }
  const code = response.error_code ? `${response.error_code}: ` : "";
  return {
    ok: false,
    error: `${code}${response.description ?? "send failed"}`,
  };
}

/** Builds the pairing deep link a participant taps to connect their chat:
 * `https://t.me/<bot>?start=<token>`. The bot sees `/start <token>`. */
export function pairingDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(token)}`;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = "telegram";
  #transport: TelegramTransport;

  constructor(opts: { botToken: string; transport?: TelegramTransport }) {
    this.#transport = opts.transport ?? fetchTransport(opts.botToken);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const response = await this.#transport("sendMessage", {
        chat_id: message.to,
        text: message.body,
      });
      return toSendResult(response);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "send failed",
      };
    }
  }
}
