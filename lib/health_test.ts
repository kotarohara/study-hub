// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";
import { checkDatabase, checkStorage } from "./health.ts";

const config = loadConfig({});

Deno.test("checkDatabase succeeds against the dev stack", async () => {
  const result = await checkDatabase(config.DATABASE_URL);
  assert.deepEqual(result, { ok: true });
});

Deno.test("checkDatabase reports unreachable database", async () => {
  const result = await checkDatabase(
    "postgres://nobody:wrong@localhost:54329/nope",
  );
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

Deno.test("checkStorage succeeds against the dev stack", async () => {
  const result = await checkStorage(config.S3_ENDPOINT);
  assert.deepEqual(result, { ok: true });
});

Deno.test("checkStorage reports unreachable endpoint", async () => {
  const result = await checkStorage("http://localhost:59999");
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
