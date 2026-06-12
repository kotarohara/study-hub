import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "./config.ts";

Deno.test("development: defaults match compose.dev.yml with empty env", () => {
  const config = loadConfig({});
  assert.equal(config.APP_ENV, "development");
  assert.equal(
    config.DATABASE_URL,
    "postgres://studyhub:studyhub@localhost:5432/studyhub",
  );
  assert.equal(config.S3_ENDPOINT, "http://localhost:9000");
  assert.equal(config.SMTP_PORT, 1025);
});

Deno.test("explicit env vars override defaults", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://other:pw@db.example:5432/other",
    SMTP_PORT: "2525",
  });
  assert.equal(
    config.DATABASE_URL,
    "postgres://other:pw@db.example:5432/other",
  );
  assert.equal(config.SMTP_PORT, 2525);
});

Deno.test("production: missing variables fail fast and name every one", () => {
  let message = "";
  assert.throws(
    () => loadConfig({ APP_ENV: "production" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      message = err.message;
      return true;
    },
  );
  for (
    const key of [
      "DATABASE_URL",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "SMTP_HOST",
      "MAIL_FROM",
    ]
  ) {
    assert.ok(
      message.includes(key),
      `expected error to mention ${key}: ${message}`,
    );
  }
});

Deno.test("production: explicit configuration is accepted", () => {
  const config = loadConfig({
    APP_ENV: "production",
    APP_URL: "https://studyhub.example.org",
    DATABASE_URL: "postgres://app:secret@10.0.0.5:5432/studyhub",
    S3_ENDPOINT: "https://s3.ap-southeast-1.amazonaws.com",
    S3_REGION: "ap-southeast-1",
    S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_BUCKET_FILES: "studyhub-files-prod",
    S3_BUCKET_BACKUPS: "studyhub-backups-prod",
    SMTP_HOST: "email-smtp.ap-southeast-1.amazonaws.com",
    SMTP_PORT: "587",
    MAIL_FROM: "StudyHub <noreply@studyhub.example.org>",
  });
  assert.equal(config.APP_ENV, "production");
  assert.equal(config.S3_REGION, "ap-southeast-1");
});

Deno.test("invalid URL is rejected with a ConfigError", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: "not-a-url" }), ConfigError);
});

Deno.test("invalid APP_ENV is rejected", () => {
  assert.throws(() => loadConfig({ APP_ENV: "staging" }), ConfigError);
});

Deno.test("backup knobs default in every environment", () => {
  const dev = loadConfig({});
  assert.equal(dev.BACKUP_CRON_ENABLED, false);
  assert.equal(dev.BACKUP_CRON, "0 18 * * *");
  assert.equal(
    loadConfig({ BACKUP_CRON_ENABLED: "true" }).BACKUP_CRON_ENABLED,
    true,
  );
  assert.throws(
    () => loadConfig({ BACKUP_CRON_ENABLED: "banana" }),
    ConfigError,
  );
});

Deno.test("invalid SMTP_PORT is rejected", () => {
  assert.throws(() => loadConfig({ SMTP_PORT: "0" }), ConfigError);
  assert.throws(() => loadConfig({ SMTP_PORT: "notaport" }), ConfigError);
});
