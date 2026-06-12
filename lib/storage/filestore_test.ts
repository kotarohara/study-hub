// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { createFileStores } from "./filestore.ts";

const config = loadConfig();
const { files } = createFileStores(config);
const prefix = `test/${crypto.randomUUID()}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("filestore: put/get roundtrip", async () => {
  const key = `${prefix}/roundtrip.txt`;
  await files.put(key, encoder.encode("hello studyhub"), {
    contentType: "text/plain",
  });
  assert.equal(decoder.decode(await files.get(key)), "hello studyhub");
  await files.delete(key);
});

Deno.test("filestore: exists and delete", async () => {
  const key = `${prefix}/exists.txt`;
  assert.equal(await files.exists(key), false);
  await files.put(key, encoder.encode("x"));
  assert.equal(await files.exists(key), true);
  await files.delete(key);
  assert.equal(await files.exists(key), false);
});

Deno.test("filestore: list by prefix", async () => {
  const keys = [`${prefix}/list/a.txt`, `${prefix}/list/b.txt`];
  for (const key of keys) await files.put(key, encoder.encode("x"));
  assert.deepEqual(await files.list(`${prefix}/list/`), keys);
  for (const key of keys) await files.delete(key);
});

Deno.test("filestore: presigned GET serves the object", async () => {
  const key = `${prefix}/presign-get.txt`;
  await files.put(key, encoder.encode("signed read"));
  const url = await files.presignGet(key);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "signed read");
  await files.delete(key);
});

Deno.test("filestore: presigned PUT uploads the object", async () => {
  const key = `${prefix}/presign-put.txt`;
  const url = await files.presignPut(key, { contentType: "text/plain" });
  const res = await fetch(url, {
    method: "PUT",
    body: "signed write",
    headers: { "content-type": "text/plain" },
  });
  assert.equal(res.status, 200);
  await res.body?.cancel();
  assert.equal(decoder.decode(await files.get(key)), "signed write");
  await files.delete(key);
});
