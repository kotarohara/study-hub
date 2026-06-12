// Declarative route → audit-action rules, kept free of Fresh imports so the
// matching logic is unit-testable without JSR access.

export interface AuditRule {
  method: string;
  /** URLPattern pathname, e.g. "/participants/:id". */
  pathname: string;
  action: string;
  objectType?: string;
  /** Path param to record as object id. */
  objectIdParam?: string;
}

export interface AuditMatch {
  action: string;
  objectType?: string;
  objectId?: string;
}

export function compileRules(rules: AuditRule[]) {
  const compiled = rules.map((rule) => ({
    rule,
    pattern: new URLPattern({ pathname: rule.pathname }),
  }));

  return function match(method: string, url: string): AuditMatch | null {
    for (const { rule, pattern } of compiled) {
      if (rule.method !== method) continue;
      const result = pattern.exec(url);
      if (!result) continue;
      return {
        action: rule.action,
        objectType: rule.objectType,
        objectId: rule.objectIdParam
          ? result.pathname.groups[rule.objectIdParam]
          : undefined,
      };
    }
    return null;
  };
}
