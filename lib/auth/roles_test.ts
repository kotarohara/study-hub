import assert from "node:assert/strict";
import { hasRole, type Role } from "./roles.ts";

Deno.test("role hierarchy: PI > Researcher > Assistant > Collaborator", () => {
  const order: Role[] = ["collaborator", "assistant", "researcher", "pi"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(
        hasRole(order[i], order[j]),
        i >= j,
        `${order[i]} vs ${order[j]}`,
      );
    }
  }
});
