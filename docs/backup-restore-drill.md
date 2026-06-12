# Backup & Restore Drill

Self-hosted Postgres means we own backups (spec §6). A backup that has never
been restored is not a backup — run this drill **quarterly** and after any
change to the backup pipeline. The CI suite runs the same cycle automatically
on every push (`lib/backup_test.ts`), but the drill verifies the
human-operated path end to end.

## How backups work

- `lib/backup.ts` runs `pg_dump --format=custom` and uploads to the
  `studyhub-backups` bucket under `pg_dump/studyhub-<timestamp>.dump`.
- The bucket is **versioned** (MinIO locally via `minio-init`; S3 in
  production), so even an overwritten or deleted object is recoverable.
- Nightly schedule: `Deno.cron` in the app process — enable with
  `BACKUP_CRON_ENABLED=true` (and `--unstable-cron`), cadence via
  `BACKUP_CRON` (default `0 18 * * *` UTC = 02:00 SGT).
- Manual: `deno task db:backup` · in dev also `POST /api/dev/backup`.

## Drill procedure (~10 minutes, local stack)

1. `deno task stack:up && deno task db:migrate && deno task db:seed`
2. Note current state: `deno task db:seed` prints seeded members; or query
   `select count(*) from members`.
3. Take a backup: `deno task db:backup` — record the printed key.
4. Inflict damage: delete a row (or drop the table) via psql:
   `docker compose -f compose.dev.yml exec postgres psql -U studyhub -c "delete from members"`
5. Restore: `deno task db:restore` (latest) or `deno task db:restore <key>`.
6. Verify the deleted rows are back (step 2 query matches).
7. Record date, operator, dump size, and any surprises below.

In production the same commands run against the live `.env`; do the drill
against the **staging** compose stack, never the live database.

## Drill log

| Date | Operator | Backup key | Result / notes |
| ---- | -------- | ---------- | -------------- |
|      |          |            |                |
