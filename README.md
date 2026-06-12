# StudyHub

StudyHub is a Deno/Fresh 2 application for managing study operations. It uses
Vite, Preact, Tailwind CSS, Postgres, MinIO-compatible object storage, and
Mailpit for local email capture.

## Prerequisites

- Deno
- Docker with Docker Compose
- Postgres client tools (`pg_dump` and `pg_restore`) for backup/restore commands
  and the backup integration test

The project uses Deno's manual `node_modules` mode, so run `deno install` after
cloning or when dependencies change.

## Quick Start

```sh
deno install
deno task stack:up
deno task db:seed
deno task dev
```

Open <http://127.0.0.1:5173/login>.

Seeded accounts all use the password `studyhub-dev`:

- `pi@studyhub.local`
- `researcher@studyhub.local`
- `assistant@studyhub.local`
- `collaborator@studyhub.local`

Local development does not require an `.env` file. In `development` and `test`,
`lib/config.ts` supplies defaults that match `compose.dev.yml`.

## Local Services

`deno task stack:up` starts:

- Postgres: `localhost:5432`
- MinIO API: `http://localhost:9000`
- MinIO console: `http://localhost:9001` (`minioadmin` / `minioadmin`)
- Mailpit SMTP: `localhost:1025`
- Mailpit UI: <http://localhost:8025>

Stop the stack with:

```sh
deno task stack:down
```

The stack task also creates the MinIO buckets `studyhub-files` and
`studyhub-backups`, and enables versioning on `studyhub-backups`.

## Common Commands

```sh
deno task dev        # Start the Vite/Fresh dev server
deno task check      # Format check, lint, and type-check
deno task test       # Run tests; integration tests expect the local stack
deno task build      # Build production assets into _fresh/
deno task start      # Serve the built app with deno serve
deno task db:migrate # Apply pending Drizzle migrations
deno task db:seed    # Apply migrations and seed local dev members
deno task db:backup  # Upload a pg_dump backup to object storage
deno task db:restore # Restore the latest or selected backup
```

`deno task db:seed` is idempotent and also runs migrations.

## Verification Notes

Verified in this checkout:

- `deno task check` passes.
- `deno task build` passes.
- `deno task test` passes all non-backup tests with the local stack running; the
  backup test additionally requires `pg_dump` on `PATH`.
- `deno task dev` starts at <http://127.0.0.1:5173/>.
- `GET /health` returns database and storage checks when the stack is running.

If `deno task stack:up` fails during the `minio-init` helper step, check Docker's
ability to pull `minio/mc:latest`. The app services may still be running, but
storage-backed features require the two buckets above.
