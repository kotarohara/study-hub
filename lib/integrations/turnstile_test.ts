// Pure-logic tests — no stack and, crucially, no network.
import assert from "node:assert/strict";
import { loadConfig } from "../config.ts";
import { STUB_FAIL_TOKEN, verifyTurnstile } from "./turnstile.ts";

const PROD_BASE = {
  APP_ENV: "production",
  APP_URL: "https://studyhub.example.org",
  DATABASE_URL: "postgres://app:secret@10.0.0.5:5432/studyhub",
  S3_ENDPOINT: "https://s3.ap-southeast-1.amazonaws.com",
  S3_REGION: "ap-southeast-1",
  S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_BUCKET_FILES: "files",
  S3_BUCKET_BACKUPS: "backups",
  SMTP_HOST: "smtp.example",
  SMTP_PORT: "587",
  MAIL_FROM: "x@example.org",
  PII_ENCRYPTION_KEYS: "1:c3R1ZHlodWItZGV2LW9ubHktYWVzLWtleS0zMi1ieSE=",
  MAGIC_LINK_SECRET: "a-production-secret-of-sufficient-length!!",
  PII_INDEX_SECRET: "another-production-secret-of-sufficient-len",
};

Deno.test("dev/test stub: accepts without network, fail token testable", async () => {
  const config = loadConfig({});
  assert.equal(await verifyTurnstile({ config, token: "anything" }), true);
  assert.equal(await verifyTurnstile({ config, token: "" }), true);
  assert.equal(
    await verifyTurnstile({ config, token: STUB_FAIL_TOKEN }),
    false,
  );
});

Deno.test("production: fails closed when unconfigured or token missing", async () => {
  // No TURNSTILE_SECRET_KEY → reject everything (never skip bot checks).
  const unconfigured = loadConfig(PROD_BASE);
  assert.equal(
    await verifyTurnstile({ config: unconfigured, token: "anything" }),
    false,
  );
  // Configured but empty token → rejected before any network call.
  const configured = loadConfig({
    ...PROD_BASE,
    TURNSTILE_SECRET_KEY: "secret",
  });
  assert.equal(await verifyTurnstile({ config: configured, token: "" }), false);
});
