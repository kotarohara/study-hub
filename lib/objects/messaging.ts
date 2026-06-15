// Messaging core (spec §3.8): render a template, log the message (with PII
// encrypted at rest), and hand it to a ChannelAdapter — every send is a
// recorded Message. The job runner (Phase 3.5) drives enqueue + deliver on
// a schedule with retries; here we provide the building blocks and an
// at-most-once enqueue keyed by idempotencyKey.
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  enrollments,
  type Message,
  type MessageChannel,
  messages,
  participants,
} from "../db/schema.ts";
import { errorChainIncludes } from "../db/errors.ts";
import { type ChannelAdapter, getAdapter } from "../integrations/channel.ts";
import { renderMessage } from "./message_templates.ts";

export class MessagingError extends Error {}

export interface EnqueueOptions {
  channel: MessageChannel;
  /** Recipient address / chat id / webhook target (PII; encrypted). */
  to: string;
  templateKey: string;
  fields: Record<string, string>;
  enrollmentId?: string;
  sessionId?: string;
  /** Supplying this makes the enqueue at-most-once (returns the existing
   * row on a repeat instead of queuing a duplicate). */
  idempotencyKey?: string;
  /** Hold delivery until this time (a scheduled reminder). Null/omitted =
   * deliver on the next runner tick. */
  nextAttemptAt?: Date;
}

export interface EnqueueResult {
  message: Message;
  /** True when an existing message was returned for a repeated key. */
  deduped: boolean;
}

/** Renders and logs a queued message. Throws before writing if the
 * template is unknown or a merge field is unresolved — a half-rendered
 * message is never stored or sent. */
export async function enqueueMessage(
  db: Db,
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  if (!opts.to.trim()) throw new MessagingError("A recipient is required.");
  const rendered = renderMessage(opts.templateKey, opts.fields);

  try {
    const [message] = await db
      .insert(messages)
      .values({
        channel: opts.channel,
        templateKey: opts.templateKey,
        recipient: opts.to.trim(),
        subject: rendered.subject ?? null,
        body: rendered.body,
        enrollmentId: opts.enrollmentId ?? null,
        sessionId: opts.sessionId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        nextAttemptAt: opts.nextAttemptAt ?? null,
      })
      .returning();
    return { message, deduped: false };
  } catch (err) {
    if (
      opts.idempotencyKey &&
      errorChainIncludes(err, "messages_idempotency_key_unique")
    ) {
      const existing = await db.query.messages.findFirst({
        where: eq(messages.idempotencyKey, opts.idempotencyKey),
      });
      if (existing) return { message: existing, deduped: true };
    }
    throw err;
  }
}

/**
 * Delivers a queued message through its channel adapter and records the
 * outcome (status, attempt count, provider id or error). Idempotent on an
 * already-sent message. `adapter` may be injected (tests); otherwise the
 * registered adapter for the message's channel is used.
 */
export async function deliverMessage(
  db: Db,
  messageId: string,
  adapter?: ChannelAdapter,
): Promise<Message> {
  const message = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });
  if (!message) throw new MessagingError("Message not found.");
  if (message.status === "sent") return message;

  const channelAdapter = adapter ?? getAdapter(message.channel);
  if (!channelAdapter) {
    const [updated] = await db
      .update(messages)
      .set({
        status: "failed",
        attempts: message.attempts + 1,
        lastError: `No adapter registered for channel "${message.channel}"`,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id))
      .returning();
    return updated;
  }

  // recipient/subject/body decrypt transparently on read.
  const result = await channelAdapter.send({
    to: message.recipient,
    subject: message.subject ?? undefined,
    body: message.body,
  });

  const [updated] = await db
    .update(messages)
    .set({
      status: result.ok ? "sent" : "failed",
      attempts: message.attempts + 1,
      providerMessageId: result.providerMessageId ?? message.providerMessageId,
      lastError: result.ok ? null : (result.error ?? "send failed"),
      sentAt: result.ok ? new Date() : message.sentAt,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, message.id))
    .returning();
  return updated;
}

/** Delivery-log row without PII (no recipient/subject/body) for list views. */
export interface MessageLogRow {
  id: string;
  channel: MessageChannel;
  templateKey: string;
  status: Message["status"];
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

const LOG_COLUMNS = {
  id: messages.id,
  channel: messages.channel,
  templateKey: messages.templateKey,
  status: messages.status,
  attempts: messages.attempts,
  lastError: messages.lastError,
  createdAt: messages.createdAt,
  sentAt: messages.sentAt,
} as const;

export async function listMessagesOfEnrollment(
  db: Db,
  enrollmentId: string,
): Promise<MessageLogRow[]> {
  return await db
    .select(LOG_COLUMNS)
    .from(messages)
    .where(eq(messages.enrollmentId, enrollmentId))
    .orderBy(desc(messages.createdAt));
}

/** A study's delivery-log row: pseudonymous (participant code only, never
 * PII) for the study Sessions tab. */
export interface StudyMessageLogRow extends MessageLogRow {
  participantCode: string;
}

/** Lists messages for a study via its enrollments, newest first. Joins to
 * the participant only for the pseudonymous code — no PII columns. */
export async function listMessagesOfStudy(
  db: Db,
  studyId: string,
): Promise<StudyMessageLogRow[]> {
  return await db
    .select({ ...LOG_COLUMNS, participantCode: participants.code })
    .from(messages)
    .innerJoin(enrollments, eq(messages.enrollmentId, enrollments.id))
    .innerJoin(participants, eq(enrollments.participantId, participants.id))
    .where(eq(enrollments.studyId, studyId))
    .orderBy(desc(messages.createdAt));
}

export async function getMessage(
  db: Db,
  messageId: string,
): Promise<Message | null> {
  const message = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });
  return message ?? null;
}
