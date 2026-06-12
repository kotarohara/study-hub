import { z } from "zod";

/**
 * Application configuration, loaded from environment variables and validated
 * with Zod. Fails fast with a list of every missing/invalid variable.
 *
 * In `development` and `test`, missing variables fall back to defaults that
 * match the local stack in `compose.dev.yml`, so a fresh checkout runs with
 * zero configuration. In `production` every variable must be set explicitly —
 * there are no insecure fallbacks.
 */

export const APP_ENVS = ["development", "test", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const ConfigSchema = z.object({
  APP_ENV: z.enum(APP_ENVS),
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_FILES: z.string().min(1),
  S3_BUCKET_BACKUPS: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  MAIL_FROM: z.string().min(1),
  // Comma-separated `<version>:<base64 32-byte key>` pairs; highest version
  // encrypts, all versions decrypt (see lib/crypto/encryption.ts).
  PII_ENCRYPTION_KEYS: z.string().regex(
    /^\d+:[A-Za-z0-9+/]+=*(,\d+:[A-Za-z0-9+/]+=*)*$/,
    "expected comma-separated <version>:<base64key> pairs",
  ),
  MAGIC_LINK_SECRET: z.string().min(32),
  /** Keyed blind index for encrypted PII lookups (dedup). NEVER rotate
   * without re-indexing contact_channels.value_index. */
  PII_INDEX_SECRET: z.string().min(32),
  // Schema-level defaults: optional knobs, defaulted in every environment.
  BACKUP_CRON_ENABLED: z.stringbool().default(false),
  BACKUP_CRON: z.string().default("0 18 * * *"), // 02:00 SGT
});

export type Config = z.infer<typeof ConfigSchema>;

/** Defaults matching compose.dev.yml; applied only outside production. */
const DEV_DEFAULTS: Record<string, string> = {
  APP_URL: "http://localhost:8000",
  DATABASE_URL: "postgres://studyhub:studyhub@localhost:5432/studyhub",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
  S3_BUCKET_FILES: "studyhub-files",
  S3_BUCKET_BACKUPS: "studyhub-backups",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  MAIL_FROM: "StudyHub <studyhub@localhost>",
  PII_ENCRYPTION_KEYS: "1:c3R1ZHlodWItZGV2LW9ubHktYWVzLWtleS0zMi1ieSE=",
  MAGIC_LINK_SECRET: "studyhub-dev-only-magic-link-secret-do-not-deploy",
  PII_INDEX_SECRET: "studyhub-dev-only-pii-index-secret-do-not-deploy",
};

export class ConfigError extends Error {}

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Config {
  const appEnv = env.APP_ENV ?? "development";

  const merged: Record<string, string | undefined> = { APP_ENV: appEnv };
  for (const key of Object.keys(ConfigSchema.shape)) {
    if (key === "APP_ENV") continue;
    merged[key] = env[key] ??
      (appEnv === "production" ? undefined : DEV_DEFAULTS[key]);
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(
      `Invalid configuration (APP_ENV=${appEnv}):\n${details}`,
    );
  }
  return result.data;
}

let cached: Config | undefined;

/** Process-wide config, loaded once from `Deno.env` on first use. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
