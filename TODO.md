# StudyHub — Implementation TODO

Tracks implementation progress against `study-hub-spec.md` (v0.5). Tasks follow the
spec's phase plan (§8) but are reorganized **local-first**: everything must run and
be testable on a laptop with Docker Compose; AWS deployment is the final phase.

## How to work this list

- Work top-to-bottom within a phase; phases are ordered by dependency.
- A task is done when: code + `deno test` coverage exist, `deno task check`
  (fmt + lint + types) passes, and the feature works against the local compose stack.
- Check off tasks (`[x]`) and add brief notes/divergences inline as work proceeds.
- Spec divergences also go in CLAUDE.md and the spec's Decision Log (§9).

## Local-first ground rules

- **Local stack:** `docker compose -f compose.dev.yml up` runs Postgres 16,
  MinIO (S3-compatible), and Mailpit (SMTP catcher with web UI). The app itself runs
  via `deno task dev` for hot reload.
- **Every external service sits behind an interface** with a local implementation:
  - Object storage → `FileStore` interface: S3 impl (prod) / MinIO impl (dev, same S3 API)
  - Email → `ChannelAdapter` impl for SES (prod) / SMTP-to-Mailpit (dev)
  - Telegram / Discord / Notion → adapters with fake/logging impls; webhooks tested by
    POSTing simulated payloads
  - Turnstile → verification stub when `ENV=development`
- **No test may require network access or real credentials.**
- `.env.example` documents every variable; dev defaults work out of the box.

---

## Phase 0 — Foundations (all local)

### 0.1 Scaffold
- [ ] Initialize Fresh 2 project; `deno.json` tasks: `dev`, `test`, `check` (fmt+lint+types), `db:migrate`, `db:seed`
- [ ] `compose.dev.yml`: Postgres 16 + MinIO + Mailpit, with healthchecks and volumes
- [ ] `.env.example` + config loader (Zod-validated, fails fast on missing vars)
- [ ] `/health` route (checks DB + storage connectivity)
- [ ] GitHub Actions CI: `deno task check` + `deno test` against service containers

### 0.2 Data layer + backups
- [ ] Drizzle ORM setup: connection pool, migration runner, first migration (members table as guinea pig)
- [ ] Test helpers: per-test transaction rollback or template-DB reset; fake-data factories
- [ ] Seed script with realistic fake data (faker), runnable via `deno task db:seed`
- [ ] `FileStore` interface + S3-API implementation (works against MinIO and real S3); presigned upload/download URLs; tests against MinIO
- [ ] `scripts/backup.sh`: `pg_dump` → versioned bucket (MinIO locally); `scripts/restore.sh`; automated test that backs up, drops, restores, verifies
- [ ] Backup job wiring via `Deno.cron` (interval configurable; manual-trigger route in dev)

### 0.3 Crypto & tokens
- [ ] AES-256-GCM field encryption helpers (encrypt/decrypt, key from env, versioned key id for future rotation) + tests incl. tamper detection
- [ ] Drizzle custom column type for encrypted PII fields
- [ ] HMAC magic-link tokens: sign/verify with expiry + purpose scoping + tests

### 0.4 Auth & members
- [ ] Members schema + Argon2id hashing + login/logout routes + session cookies (HttpOnly, Secure, SameSite); CSRF tokens
- [ ] PI-invite flow (invite token → set password); no self-signup
- [ ] Role middleware (PI > Researcher > Assistant > Collaborator) + route guards + tests
- [ ] Rate limiting middleware on auth + public routes (in-process token bucket)

### 0.5 Audit log
- [ ] Append-only `audit_log` table (no UPDATE/DELETE grants) + write helper
- [ ] Audit middleware covering: PII views/exports, consent changes, deletions, payment approvals + tests proving append-only behavior

### 0.6 OOUI shell
- [ ] App layout: global nav listing object collections, design tokens, status-badge component
- [ ] Reusable **collection view** (filter/sort/paginate at 50, bulk-action slots)
- [ ] Reusable **detail view** (identity header, property panel, related-object tabs, action bar gated by lifecycle state)
- [ ] Reusable **inline/compact chip/card** view
- [ ] Generic CRUD + duplicate + archive action plumbing shared across object types

## Phase 1 — Studies & Documents

- [ ] 1.1 Project CRUD + membership (collection/detail views, archive)
- [ ] 1.2 Study CRUD: lifecycle states (draft → IRB review → recruiting → running → analysis → archived) + stepper; state-gated actions; duplication (design + docs + timeline, minus participants/data)
- [ ] 1.3 Design editor: structured fields (RQs, hypotheses, IVs/DVs, conditions, design type, target N, exclusion criteria) + one-pager render
- [ ] 1.4 Condition assignment engine: random + manual counterbalanced assignment with audit trail + tests
- [ ] 1.5 Documents: upload/create, version history + diff, review statuses, reviewer comments
- [ ] 1.6 Oversight pathway selector: IRB-reviewed / IRB-exempt (reference required) / Internal Pilot (PI confirmation + justification → audit log; permanent PILOT badge; pilot data-quarantine flag)
- [ ] 1.7 IRB workflow: merge-field document templates from Study fields, approval metadata (protocol #, dates), expiry warnings, recruiting guard (blocked until approved consent Document)
- [ ] 1.8 "Promote to full study" action (duplicate into fresh IRB-reviewed Study, zero data carry-over) + tests
- [ ] 1.9 Milestones/Tasks: CRUD, dependencies + blocking, methodology templates
- [ ] 1.10 TimelineGantt island + project roll-up calendar

## Phase 2 — Participants & Recruitment

- [ ] 2.1 Participant + ContactChannel schemas (encrypted PII columns), demographics, do-not-contact flag, participation history
- [ ] 2.2 Cross-study deduplication warnings on participant create/import
- [ ] 2.3 Simple-form builder Instrument (item types, no branching) + versioning + scoring rules; external-instrument records (Qualtrics links)
- [ ] 2.4 Public screener pages at `p/[token]`: Turnstile (stubbed in dev) + rate limits; eligibility rules → Enrollment status
- [ ] 2.5 Enrollment lifecycle (screened → eligible → consented → active → completed/withdrawn/excluded) + pilot-enrollment flag
- [ ] 2.6 Consent flow: page rendered from approved Document version, e-signature (encrypted), consent-to-recontact flag, re-consent on amendment
- [ ] 2.7 Recruitment funnel stats per channel + quota dashboard (per-stratum counts vs targets; manual pause)
- [ ] 2.8 Re-recruitment: pool filtering + bulk invites via preferred ContactChannel

## Phase 3 — Sessions, Reminders & Comms *(first usable release)*

- [ ] 3.1 Session scheduling: slot publishing, self-booking via magic link, reschedule/no-show tracking
- [ ] 3.2 ICS feed generation + tests
- [ ] 3.3 Messaging core: Message object, `ChannelAdapter` interface, templates with merge fields, delivery log
- [ ] 3.4 Email adapter: SMTP (Mailpit) for dev, SES for prod behind same interface; bounce-webhook route (`hooks/ses-bounces.ts`) tested with simulated SNS payloads
- [ ] 3.5 Job infrastructure: `Deno.cron` + `jobs`/`messages` tables, idempotency keys, retries with backoff, failure alerts via notification adapter + tests (incl. duplicate-send prevention)
- [ ] 3.6 Session reminders + booking confirmations end-to-end (visible in Mailpit)
- [ ] 3.7 Telegram adapter: webhook route, pairing deep link (one-time token → verified ContactChannel), reminders, `/stop` → email fallback; tested with simulated Bot API payloads
- [ ] 3.8 Diary/ESM engine: schedule builder (fixed/interval/randomized windows), prompt dispatch, diary entry pages via magic link, optional quick replies
- [ ] 3.9 Discord webhook adapter (internal events; pseudonymous IDs only — assert no PII in payloads via test)

## Phase 4 — Data & Compensation

- [ ] 4.1 Dataset object + file uploads to FileStore; pseudonymous linkage (record → participant ID + condition + session); pilot-data exclusion by default + tests
- [ ] 4.2 Form responses captured as Dataset records
- [ ] 4.3 Generic CSV/JSON importer with column-mapping UI; codebook generation
- [ ] 4.4 EDA islands (client-side, ≤100k rows): summary stats, histograms/box plots, group-by-condition, scale auto-scoring
- [ ] 4.5 Export: CSV/JSON; profiles full (PI-only) / de-identified / OSF-ready; analysis-ready bundle (data + codebook + R/Python loader); export audit + tests proving PII never leaks into de-identified profiles
- [ ] 4.6 Compensation object (amount, scheme, method, status pending → approved → paid); outstanding-payments dashboard
- [ ] 4.7 PayNow/PayPal run sheets + mark-as-paid; Prolific ID tracking; payment confirmations to participants
- [ ] 4.8 Ledger export (Name / Phone / Amount), PI-gated + audited + tests
- [ ] 4.9 Withdrawal workflow (action, data handling per consent) + retention timers + PI-approved purge

## Phase 5 — Polish (still local)

- [ ] 5.1 Notion one-way push adapter (fake impl + payload tests; no PII assertion) + Notion-page links as Documents
- [ ] 5.2 Health dashboard: funnel vs target N, upcoming sessions, overdue tasks
- [ ] 5.3 Accessibility pass on participant-facing pages (WCAG 2.1 AA)
- [ ] 5.4 Security review of PII flows: verify every PII read/export path is role-gated + audited; pen-test magic links (expiry, purpose confusion, tampering)
- [ ] 5.5 Full local dress rehearsal: seed → run a study end-to-end (recruit → consent → schedule → remind → collect → compensate → export) against the compose stack

## Phase 6 — AWS Deployment (only when the above is in good shape)

- [ ] 6.1 Production `Dockerfile` + `docker-compose.yml` (caddy + app + postgres) + `Caddyfile` (TLS, rate limits); verify the prod compose stack boots locally first
- [ ] 6.2 Provision Lightsail/EC2 in `ap-southeast-1` (Ubuntu LTS, static IP, ports 80/443 only); documented `scripts/setup.sh`
- [ ] 6.3 Route 53 hosted zone + A record; HTTPS hello-world live
- [ ] 6.4 Real S3 bucket (private, SSE-S3, versioning, lifecycle rules); point FileStore + backups at it
- [ ] 6.5 SES production access (ap-southeast-1) + SNS bounce topic wired to the bounce hook
- [ ] 6.6 Real Turnstile keys; real Telegram bot + webhook URL; Discord webhook URLs
- [ ] 6.7 GitHub Actions deploy: build image → SSH → `docker compose pull && up -d`
- [ ] 6.8 Nightly backup verified in S3 (versioned) + weekly instance snapshot + backup-failure alert to Discord
- [ ] 6.9 Uptime monitor on `/health`; restore drill #1 on staging compose file — document it
