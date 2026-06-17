// Pure-logic tests — no stack required.
import assert from "node:assert/strict";
import { type Alert, alert, resetAlertSink, setAlertSink } from "./alerts.ts";

Deno.test("alert routes to the registered sink", async () => {
  const seen: Alert[] = [];
  setAlertSink({ notify: (a) => void seen.push(a) });
  await alert({ kind: "x.y", detail: "something broke" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "x.y");
  resetAlertSink();
});

Deno.test("a throwing sink never propagates to the caller", async () => {
  setAlertSink({
    notify: () => {
      throw new Error("sink down");
    },
  });
  // Must not throw.
  await alert({ kind: "z", detail: "d" });
  resetAlertSink();
});
