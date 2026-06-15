// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  isMessageTemplate,
  MESSAGE_TEMPLATES,
  renderMessage,
  TemplateError,
} from "./message_templates.ts";

Deno.test("renderMessage: substitutes subject and body merge fields", () => {
  const rendered = renderMessage("booking_confirmation", {
    first_name: "Ada",
    study_title: "Maps Study",
    session_time: "Mon 1 Jul, 10:00",
    session_location: " at Lab 3A",
  });
  assert.equal(rendered.subject, "Your Maps Study session is booked");
  assert.ok(rendered.body.includes("Hi Ada,"));
  assert.ok(rendered.body.includes("Mon 1 Jul, 10:00 at Lab 3A"));
  assert.ok(!rendered.body.includes("{{"));
});

Deno.test("renderMessage: blank field allowed, missing field is an error", () => {
  // An intentionally-empty field renders to nothing, not an error.
  const ok = renderMessage("session_reminder", {
    first_name: "Bo",
    study_title: "S",
    session_time: "now",
    session_location: "",
  });
  assert.ok(ok.body.includes("at now."));

  // Omitting a declared field leaves a placeholder → rejected.
  assert.throws(
    () =>
      renderMessage("session_reminder", {
        first_name: "Bo",
        study_title: "S",
        session_time: "now",
      }),
    /Unresolved merge field/,
  );
});

Deno.test("renderMessage: unknown template key is rejected", () => {
  assert.throws(() => renderMessage("nope", {}), TemplateError);
  assert.equal(isMessageTemplate("nope"), false);
  assert.equal(isMessageTemplate("session_reminder"), true);
});

Deno.test("every starter template declares the fields its text uses", () => {
  for (const tpl of Object.values(MESSAGE_TEMPLATES)) {
    const used = new Set(
      [...`${tpl.subject ?? ""}\n${tpl.body}`.matchAll(
        /\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
      )]
        .map((m) => m[1].toLowerCase()),
    );
    for (const field of used) {
      assert.ok(
        tpl.fields.includes(field),
        `${tpl.key} uses {{${field}}} but does not declare it`,
      );
    }
  }
});
