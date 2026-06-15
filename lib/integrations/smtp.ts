// Minimal SMTP client (spec §6: Mailpit locally, SES SMTP in production).
// Deno has no built-in SMTP, and pulling a node mailer risks the Fresh/vite
// SSR bundle, so this hand-rolls the line protocol over Deno.connect. The
// plain path (Mailpit, no auth/TLS) is exercised by the integration test;
// the STARTTLS + AUTH LOGIN path is for SES in production.

export interface SmtpConfig {
  host: string;
  port: number;
  /** When set, the session upgrades with STARTTLS and authenticates. */
  username?: string;
  password?: string;
}

export interface SmtpEnvelope {
  /** Envelope MAIL FROM (bare address). */
  from: string;
  /** Envelope RCPT TO (bare address). */
  to: string;
  /** Full RFC 5322 message (headers + body, CRLF line endings). */
  raw: string;
}

export class SmtpError extends Error {}

const CRLF = "\r\n";

class SmtpSession {
  #conn: Deno.Conn;
  #buf = new Uint8Array(0);
  #dec = new TextDecoder();
  #enc = new TextEncoder();

  constructor(conn: Deno.Conn) {
    this.#conn = conn;
  }

  async upgradeTls(hostname: string): Promise<void> {
    this.#conn = await Deno.startTls(this.#conn as Deno.TcpConn, { hostname });
  }

  async write(text: string): Promise<void> {
    const bytes = this.#enc.encode(text);
    let offset = 0;
    while (offset < bytes.length) {
      offset += await this.#conn.write(bytes.subarray(offset));
    }
  }

  /** Reads one full reply (handles multi-line "250-" continuations). */
  async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    while (true) {
      const line = await this.#readLine();
      if (line === null) throw new SmtpError("connection closed by server");
      lines.push(line);
      // Final line of a reply is "NNN " (space); continuations use "NNN-".
      if (/^\d{3} /.test(line)) {
        return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
      }
    }
  }

  /** Sends a command and asserts the reply code is one of `expected`. */
  async cmd(line: string, expected: number[]): Promise<void> {
    await this.write(line + CRLF);
    const reply = await this.readReply();
    if (!expected.includes(reply.code)) {
      throw new SmtpError(`unexpected reply to "${line}": ${reply.text}`);
    }
  }

  close(): void {
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
  }

  async #readLine(): Promise<string | null> {
    while (true) {
      const idx = this.#indexOfCrlf();
      if (idx >= 0) {
        const line = this.#dec.decode(this.#buf.subarray(0, idx));
        this.#buf = this.#buf.subarray(idx + 2);
        return line;
      }
      const chunk = new Uint8Array(2048);
      const n = await this.#conn.read(chunk);
      if (n === null) return null;
      const merged = new Uint8Array(this.#buf.length + n);
      merged.set(this.#buf);
      merged.set(chunk.subarray(0, n), this.#buf.length);
      this.#buf = merged;
    }
  }

  #indexOfCrlf(): number {
    for (let i = 0; i + 1 < this.#buf.length; i++) {
      if (this.#buf[i] === 13 && this.#buf[i + 1] === 10) return i;
    }
    return -1;
  }
}

/** Dot-stuffing per RFC 5321 §4.5.2: lines beginning with "." get doubled. */
function dotStuff(message: string): string {
  return message.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

/** Sends one message over SMTP. Throws SmtpError on any protocol failure. */
export async function sendSmtp(
  config: SmtpConfig,
  envelope: SmtpEnvelope,
): Promise<void> {
  const session = new SmtpSession(
    await Deno.connect({ hostname: config.host, port: config.port }),
  );
  try {
    await session.readReply(); // 220 greeting
    await session.cmd(`EHLO studyhub`, [250]);

    if (config.username) {
      await session.cmd("STARTTLS", [220]);
      await session.upgradeTls(config.host);
      await session.cmd(`EHLO studyhub`, [250]);
      await session.cmd("AUTH LOGIN", [334]);
      await session.cmd(btoa(config.username), [334]);
      await session.cmd(btoa(config.password ?? ""), [235]);
    }

    await session.cmd(`MAIL FROM:<${envelope.from}>`, [250]);
    await session.cmd(`RCPT TO:<${envelope.to}>`, [250, 251]);
    await session.cmd("DATA", [354]);
    await session.write(dotStuff(envelope.raw) + CRLF + "." + CRLF);
    const dataReply = await session.readReply();
    if (dataReply.code !== 250) {
      throw new SmtpError(`message rejected: ${dataReply.text}`);
    }
    try {
      await session.cmd("QUIT", [221]);
    } catch {
      // The message is already accepted; a noisy QUIT does not matter.
    }
  } finally {
    session.close();
  }
}
