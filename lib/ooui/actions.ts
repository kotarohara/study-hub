// Actions live on objects (spec §2.2 #3) and are gated by lifecycle state
// and role. Generic plumbing shared by every object type: routes declare
// ObjectActions, resolveActions() decides enabled/disabled (with a reason),
// and ActionBar renders them uniformly. Duplicate/archive for lifecycle
// objects build on this from Phase 1.1.
import type { Role } from "../auth/roles.ts";
import { hasRole } from "../auth/roles.ts";

export interface ObjectAction {
  id: string;
  label: string;
  /** Form POST target (default) or plain link when method is "get". */
  href: string;
  method?: "post" | "get";
  tone?: "default" | "primary" | "danger";
  /** Lifecycle states in which the action is available; omit = always. */
  enabledIn?: readonly string[];
  /** Minimum role required; omit = any member. */
  minRole?: Role;
  /** Browser confirm() prompt for destructive actions. */
  confirm?: string;
}

export interface ResolvedAction extends ObjectAction {
  enabled: boolean;
  reason?: string;
}

export function resolveActions(
  actions: ObjectAction[],
  opts: { status?: string; role?: Role },
): ResolvedAction[] {
  return actions.map((action) => {
    if (action.minRole && (!opts.role || !hasRole(opts.role, action.minRole))) {
      return {
        ...action,
        enabled: false,
        reason: `Requires ${action.minRole} role`,
      };
    }
    if (
      action.enabledIn &&
      (!opts.status || !action.enabledIn.includes(opts.status))
    ) {
      return {
        ...action,
        enabled: false,
        reason: `Not available while ${opts.status ?? "stateless"}`,
      };
    }
    return { ...action, enabled: true };
  });
}
