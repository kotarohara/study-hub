import { createDefine } from "fresh";

// Type of `ctx.state`, shared among middlewares, layouts and routes.
// Grows as middleware lands (auth/session state arrives in Phase 0.4).
export interface State {
  requestId: string;
}

export const define = createDefine<State>();
