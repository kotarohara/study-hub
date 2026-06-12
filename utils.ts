import { createDefine } from "fresh";
import type { Member } from "./lib/db/schema.ts";

// Type of `ctx.state`, shared among middlewares, layouts and routes.
export interface State {
  requestId: string;
  /** Authenticated lab member, or null (set by sessionMiddleware). */
  member: Member | null;
}

export const define = createDefine<State>();
