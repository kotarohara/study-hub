// Message templates with merge fields (spec §3.8: {{first_name}},
// {{session_time}}, {{study_title}}…). Pure: a keyed registry plus a
// renderer built on renderTemplate. Unlike document templates, a message
// must be fully resolved before it goes out — any unfilled placeholder is
// an error, never literal "{{...}}" in someone's inbox.
import type { ChannelKind } from "../integrations/channel.ts";
import { renderTemplate } from "./templates.ts";

export class TemplateError extends Error {}

export interface MessageTemplate {
  key: string;
  /** Channels this template's wording suits. */
  channels: ChannelKind[];
  /** Email subject; omit for channels without one. */
  subject?: string;
  body: string;
  /** Declared merge fields, for documentation and callers' reference. */
  fields: string[];
}

export const MESSAGE_TEMPLATES: Record<string, MessageTemplate> = {
  booking_confirmation: {
    key: "booking_confirmation",
    channels: ["email", "telegram"],
    subject: "Your {{study_title}} session is booked",
    body:
      `Hi {{first_name}},\n\nYour session for {{study_title}} is confirmed for {{session_time}}{{session_location}}.\n\nNeed a different time? Use your booking link to reschedule.\n\nThank you!`,
    fields: ["first_name", "study_title", "session_time", "session_location"],
  },
  session_reminder: {
    key: "session_reminder",
    channels: ["email", "telegram"],
    subject: "Reminder: your {{study_title}} session is coming up",
    body:
      `Hi {{first_name}},\n\nA reminder that your session for {{study_title}} is at {{session_time}}{{session_location}}.\n\nSee you then!`,
    fields: ["first_name", "study_title", "session_time", "session_location"],
  },
} as const;

export function isMessageTemplate(key: string): boolean {
  return key in MESSAGE_TEMPLATES;
}

export interface RenderedMessage {
  subject?: string;
  body: string;
}

/** Renders a template fully, erroring if the key is unknown or any merge
 * field is missing (callers pass "" for intentionally-blank fields). */
export function renderMessage(
  key: string,
  fields: Record<string, string>,
): RenderedMessage {
  const template = MESSAGE_TEMPLATES[key];
  if (!template) throw new TemplateError(`Unknown message template: ${key}`);

  const body = renderTemplate(template.body, fields);
  if (body.unknown.length > 0) {
    throw new TemplateError(
      `Unresolved merge field(s) in body: ${body.unknown.join(", ")}`,
    );
  }
  if (template.subject === undefined) return { body: body.text };

  const subject = renderTemplate(template.subject, fields);
  if (subject.unknown.length > 0) {
    throw new TemplateError(
      `Unresolved merge field(s) in subject: ${subject.unknown.join(", ")}`,
    );
  }
  return { subject: subject.text, body: body.text };
}
