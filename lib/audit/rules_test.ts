import assert from "node:assert/strict";
import { compileRules } from "./rules.ts";

const match = compileRules([
  { method: "POST", pathname: "/logout", action: "auth.logout" },
  {
    method: "GET",
    pathname: "/participants/:id",
    action: "pii.view",
    objectType: "participant",
    objectIdParam: "id",
  },
]);

Deno.test("matches method and path, extracting the object id", () => {
  assert.deepEqual(match("GET", "http://x/participants/abc-123"), {
    action: "pii.view",
    objectType: "participant",
    objectId: "abc-123",
  });
  assert.deepEqual(match("POST", "http://x/logout"), {
    action: "auth.logout",
    objectType: undefined,
    objectId: undefined,
  });
});

Deno.test("does not match other methods, paths, or sub-paths", () => {
  assert.equal(match("GET", "http://x/logout"), null);
  assert.equal(match("POST", "http://x/other"), null);
  assert.equal(match("GET", "http://x/participants"), null);
  assert.equal(match("GET", "http://x/participants/1/edit"), null);
});

Deno.test("query strings do not affect matching", () => {
  assert.ok(match("GET", "http://x/participants/p1?tab=sessions"));
});
