// Merge-field document templates (spec §3.3): fields pulled from the Study
// object so the protocol stays consistent with the actual design.
// Substitution happens when PREFILLING the editor — the stored document text
// is concrete, so what was submitted to the IRB never silently changes when
// the design does.
import type { Condition, Project, Study } from "../db/schema.ts";

export interface MergeContext {
  study: Study;
  project: Project;
  conditions: Condition[];
}

export function mergeFields(ctx: MergeContext): Record<string, string> {
  const { study, project } = ctx;
  return {
    study_title: study.name,
    project_name: project.name,
    description: study.description,
    methodology: study.methodology.replaceAll("_", " "),
    oversight_pathway: study.oversightPathway.replaceAll("_", " "),
    design_type: study.designType ?? "",
    target_n: study.targetN === null ? "" : String(study.targetN),
    research_questions: study.researchQuestions,
    hypotheses: study.hypotheses,
    independent_variables: study.independentVariables,
    dependent_variables: study.dependentVariables,
    exclusion_criteria: study.exclusionCriteria,
    counterbalancing_scheme: study.counterbalancingScheme,
    conditions: ctx.conditions.map((c) => c.name).join(", "),
  };
}

export interface RenderedTemplate {
  text: string;
  /** Placeholders that had no value — left intact for the author to fill. */
  unknown: string[];
}

export function renderTemplate(
  template: string,
  fields: Record<string, string>,
): RenderedTemplate {
  const unknown = new Set<string>();
  const text = template.replaceAll(
    /\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
    (placeholder, name: string) => {
      const key = name.toLowerCase();
      if (key in fields) return fields[key];
      unknown.add(name);
      return placeholder;
    },
  );
  return { text, unknown: [...unknown] };
}

/** Built-in starter templates; institutions replace the wording, the merge
 * fields do the bookkeeping. */
export const STARTER_TEMPLATES = {
  consent_form: `CONSENT TO PARTICIPATE IN RESEARCH

Study: {{study_title}} ({{project_name}})

You are invited to take part in a {{methodology}} study. Please read this
form carefully before deciding whether to participate.

PURPOSE
{{description}}

PROCEDURE
[Describe what participants will do, and how long it takes.]

ELIGIBILITY & EXCLUSION
{{exclusion_criteria}}

RISKS AND BENEFITS
[Describe any risks and benefits.]

COMPENSATION
[Describe compensation, if any.]

DATA HANDLING
Your data will be stored under a pseudonymous identifier. Personal contact
details are kept separately and encrypted; only the principal investigator
can re-link them, and every such access is logged.

VOLUNTARY PARTICIPATION
Participation is voluntary. You may withdraw at any time without penalty.

CONSENT
By signing below I confirm I have read and understood the above and agree
to participate.`,
  irb_protocol: `IRB PROTOCOL

Title: {{study_title}}
Project: {{project_name}}
Methodology: {{methodology}}
Design: {{design_type}}, target N = {{target_n}}
Oversight pathway: {{oversight_pathway}}

RESEARCH QUESTIONS
{{research_questions}}

HYPOTHESES
{{hypotheses}}

VARIABLES
Independent: {{independent_variables}}
Dependent: {{dependent_variables}}

CONDITIONS
{{conditions}}
Counterbalancing: {{counterbalancing_scheme}}

PARTICIPANTS
Target N: {{target_n}}
Exclusion criteria: {{exclusion_criteria}}

PROCEDURE
[Describe the session flow.]

RISKS, BENEFITS AND COMPENSATION
[Describe.]

DATA HANDLING AND PRIVACY
Data is pseudonymized at collection; identifiers are stored separately,
encrypted at the application layer, with PI-only re-identification under
audit log.`,
} as const;

export type TemplateKind = keyof typeof STARTER_TEMPLATES;

export function isTemplateKind(value: string): value is TemplateKind {
  return value in STARTER_TEMPLATES;
}
