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
