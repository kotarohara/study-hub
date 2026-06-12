// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import {
  isTemplateKind,
  renderTemplate,
  STARTER_TEMPLATES,
} from "./templates.ts";

const FIELDS = {
  study_title: "Attention Study",
  project_name: "Vision",
  target_n: "24",
};

Deno.test("renderTemplate: substitutes known fields, tolerates spacing", () => {
  const { text, unknown } = renderTemplate(
    "Title: {{study_title}} ({{ project_name }}), N={{target_n}}",
    FIELDS,
  );
  assert.equal(text, "Title: Attention Study (Vision), N=24");
  assert.deepEqual(unknown, []);
});

Deno.test("renderTemplate: unknown placeholders stay intact and are reported", () => {
  const { text, unknown } = renderTemplate(
    "{{study_title}} / {{procedure}} / {{procedure}}",
    FIELDS,
  );
  assert.equal(text, "Attention Study / {{procedure}} / {{procedure}}");
  assert.deepEqual(unknown, ["procedure"]);
});

Deno.test("starter templates render without unknown merge fields", () => {
  // Every placeholder used by the built-in templates must be a real field.
  const allFields = {
    study_title: "t",
    project_name: "p",
    description: "d",
    methodology: "m",
    oversight_pathway: "o",
    design_type: "between",
    target_n: "1",
    research_questions: "rq",
    hypotheses: "h",
    independent_variables: "iv",
    dependent_variables: "dv",
    exclusion_criteria: "e",
    counterbalancing_scheme: "c",
    conditions: "a, b",
  };
  for (const [kind, template] of Object.entries(STARTER_TEMPLATES)) {
    const { unknown } = renderTemplate(template, allFields);
    assert.deepEqual(unknown, [], `${kind} has unknown fields: ${unknown}`);
  }
});

Deno.test("isTemplateKind guards the query parameter", () => {
  assert.ok(isTemplateKind("consent_form"));
  assert.ok(isTemplateKind("irb_protocol"));
  assert.ok(!isTemplateKind("other"));
  assert.ok(!isTemplateKind(""));
});
