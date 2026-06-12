import assert from "node:assert/strict";
import { type ObjectAction, resolveActions } from "./actions.ts";

const actions: ObjectAction[] = [
  { id: "edit", label: "Edit", href: "/x/edit", enabledIn: ["draft"] },
  { id: "archive", label: "Archive", href: "/x/archive", minRole: "pi" },
  { id: "view", label: "View", href: "/x", method: "get" },
];

Deno.test("state gating: actions disabled outside their lifecycle states", () => {
  const inDraft = resolveActions(actions, { status: "draft", role: "pi" });
  assert.equal(inDraft.find((a) => a.id === "edit")?.enabled, true);

  const running = resolveActions(actions, { status: "running", role: "pi" });
  const edit = running.find((a) => a.id === "edit")!;
  assert.equal(edit.enabled, false);
  assert.match(edit.reason!, /running/);
});

Deno.test("role gating: below minRole disables with reason", () => {
  const asAssistant = resolveActions(actions, {
    status: "draft",
    role: "assistant",
  });
  const archive = asAssistant.find((a) => a.id === "archive")!;
  assert.equal(archive.enabled, false);
  assert.match(archive.reason!, /pi/);

  const asPi = resolveActions(actions, { status: "draft", role: "pi" });
  assert.equal(asPi.find((a) => a.id === "archive")?.enabled, true);
});

Deno.test("ungated actions are always enabled", () => {
  const resolved = resolveActions(actions, { role: "collaborator" });
  assert.equal(resolved.find((a) => a.id === "view")?.enabled, true);
});
