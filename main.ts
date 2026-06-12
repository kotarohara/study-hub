import { App, staticFiles } from "fresh";
import type { State } from "./utils.ts";

export const app = new App<State>();

app.use(staticFiles());

app.use((ctx) => {
  ctx.state.requestId = crypto.randomUUID();
  return ctx.next();
});

app.fsRoutes();
