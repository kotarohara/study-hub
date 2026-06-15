// Pure parser for inbound Telegram Bot API updates (spec §3.8). The webhook
// route hands the raw JSON here and acts on the normalized command, so the
// whole pairing/stop flow is testable with simulated Bot API payloads and no
// network. We only care about private-chat text commands: `/start <token>`
// (pairing deep link) and `/stop` (switch back to email).

/** A normalized inbound command. `chatId` is the Telegram chat the reply
 * must go to (the participant's chat id, which a paired channel stores). */
export type TelegramCommand =
  | { kind: "start"; chatId: string; token: string | null }
  | { kind: "stop"; chatId: string }
  | { kind: "other"; chatId: string }
  | { kind: "ignore" };

/** Reads `chat.id` from a message object as a string, or null if absent. */
function chatIdOf(message: Record<string, unknown>): string | null {
  const chat = message.chat;
  if (typeof chat !== "object" || chat === null) return null;
  const id = (chat as Record<string, unknown>).id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.trim()) return id.trim();
  return null;
}

/**
 * Parses a Bot API update into a command. Never throws: anything we do not
 * understand (edits, non-text messages, other update types) becomes
 * `ignore`, so a surprising payload is a no-op rather than a 500.
 */
export function parseUpdate(raw: unknown): TelegramCommand {
  if (typeof raw !== "object" || raw === null) return { kind: "ignore" };
  const message = (raw as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    return { kind: "ignore" };
  }

  const msg = message as Record<string, unknown>;
  const chatId = chatIdOf(msg);
  if (!chatId) return { kind: "ignore" };

  const text = msg.text;
  if (typeof text !== "string" || !text.trim()) return { kind: "ignore" };

  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  // A command may be addressed to the bot in groups: "/start@StudyHubBot".
  const command = head.split("@", 1)[0].toLowerCase();

  switch (command) {
    case "/start":
      return { kind: "start", chatId, token: rest || null };
    case "/stop":
      return { kind: "stop", chatId };
    default:
      return { kind: "other", chatId };
  }
}
