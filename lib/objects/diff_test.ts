// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import { diffStats, lineDiff } from "./diff.ts";

function compact(diff: ReturnType<typeof lineDiff>): string[] {
  return diff.map((d) =>
    d.type === "same"
      ? `  ${d.line}`
      : d.type === "added"
      ? `+ ${d.line}`
      : `- ${d.line}`
  );
}

Deno.test("identical texts produce only 'same' lines", () => {
  const diff = lineDiff("a\nb\nc", "a\nb\nc");
  assert.ok(diff.every((d) => d.type === "same"));
  assert.deepEqual(diffStats(diff), { added: 0, removed: 0 });
});

Deno.test("addition, removal and change are reported per line", () => {
  const diff = lineDiff(
    "intro\nold line\noutro",
    "intro\nnew line\nextra\noutro",
  );
  assert.deepEqual(compact(diff), [
    "  intro",
    "- old line",
    "+ new line",
    "+ extra",
    "  outro",
  ]);
  assert.deepEqual(diffStats(diff), { added: 2, removed: 1 });
});

Deno.test("empty sides", () => {
  assert.deepEqual(compact(lineDiff("", "a\nb")), ["+ a", "+ b"]);
  assert.deepEqual(compact(lineDiff("a\nb", "")), ["- a", "- b"]);
  assert.deepEqual(lineDiff("", ""), []);
});

Deno.test("common prefix/suffix is preserved around an edit", () => {
  const before = ["p1", "p2", "p3", "p4"].join("\n");
  const after = ["p1", "p2 edited", "p3", "p4"].join("\n");
  const diff = lineDiff(before, after);
  assert.equal(diff.filter((d) => d.type === "same").length, 3);
});
