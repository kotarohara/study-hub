# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

This repository is **pre-implementation**. It contains only `study-hub-spec.md` (Draft v0.5) — the full specification for StudyHub, a user study management system for a single HCI research lab. There is no application code, build system, or test suite yet. **`study-hub-spec.md` is the source of truth**; read it before implementing anything, and keep implementations consistent with its Decision Log (§9) and phase plan (§8).

## What StudyHub Is

A web app that manages the full lifecycle of user studies (surveys, lab experiments, diary studies, interviews, crowdsourcing). It *orchestrates* rather than replaces specialized tools: main surveys stay in Qualtrics/Google Forms (StudyHub ingests CSV), pre-registration stays in OSF, power analysis in G*Power. StudyHub is the system of record connecting participants, consent, scheduling, compensation, and data files.

## Planned Stack & Architecture (spec §6)

- **Runtime:** Deno + Fresh 2; testing via `deno test`
- **Database:** Postgres 16 (self-hosted container) with Drizzle ORM + migrations; Zod schemas shared between server and islands
- **Deployment:** Single Lightsail/EC2 instance in `ap-southeast-1` (Singapore), Docker Compose stack: Caddy (TLS/reverse proxy) → Fresh app (with `Deno.cron` for jobs) → Postgres. Only other AWS services: S3, SES, Route 53. No external queue/scheduler — background jobs use `Deno.cron` plus `jobs`/`messages` tables for idempotency and retries.
- **Planned source layout:**
  ```
  routes/        # object detail/collection pages; p/[token]/ for public participant pages; api/; hooks/ for webhooks
  islands/       # client-side interactive components (TimelineGantt, EdaCharts, ScheduleBoard, ObjectActionBar)
  lib/           # db/, objects/, integrations/{telegram,discord,notion,email,s3}, jobs/, crypto/
  ```

## Key Conventions to Preserve

### OOUI (Object-Oriented UI) — spec §2
The UI is organized around domain objects (Project, Study, Participant, Enrollment, Session, Instrument, Dataset, Document, Compensation, etc.), not features. Every object type gets exactly three view patterns: **collection view** (filterable table/grid), **detail view** (identity header + property panel + related-object tabs + action bar), and **inline/compact view** (chip/card inside other objects' views). Actions live on objects (noun → verb), lifecycle states render as status badges that gate available actions, and CRUD/duplication behave identically across object types.

### Privacy & compliance — non-negotiable invariants
- **PII isolation:** PII lives only on Participant/ContactChannel. Datasets link records to pseudonymous participant IDs; re-identification ("break-glass") is PI-only and audit-logged.
- **App-layer encryption:** PII columns (name, email, phone/PayNow, Telegram chat ID, PayPal email, signatures) encrypted with AES-256-GCM, key in `.env`.
- **Audit log:** append-only, via middleware, covering PII views/exports, consent changes, deletions, payment approvals.
- **Pilot data quarantine:** anything flagged `pilot` (Internal Pilot studies or pilot enrollments) is excluded from datasets, quotas, and publishable exports by default. Pilot data never carries over when a pilot is promoted to a full study.
- **Oversight pathways:** every Study declares IRB-reviewed (default; recruiting blocked until an approved consent Document exists), IRB-exempt (requires exemption reference), or Internal Pilot (PI confirmation + justification, permanent badge, no public recruitment).
- **Data residency:** compute, TLS termination, database, files, and email all stay in `ap-southeast-1`.
- **No PII in Discord or Notion, ever** — pseudonymous IDs only. Discord is outbound webhooks only; Notion is one-way push only.

### Auth model
- Lab members: email + Argon2id password, session cookies, PI-invites only (no self-signup, no OAuth). Roles: PI > Researcher > Assistant > Collaborator.
- Participants: **no accounts** — signed, expiring HMAC magic links for all participant-facing pages (`p/[token]/...`). Public forms protected by Cloudflare Turnstile + rate limiting.

### Scope discipline
The spec deliberately cuts features (§4, §8.6 backlog): no Latin-square generator, no power-analysis helper, no Qualtrics/Prolific-specific importers (generic CSV mapper only), no two-way Notion sync, no WhatsApp (channel-agnostic `ChannelAdapter` interface keeps it possible later), no PayPal Payouts API. Don't build backlog items unless asked.

## Development Plan

Work follows phased order (spec §8): Phase 0 foundations (scaffold, data layer + **backups as a Phase 0 deliverable**, auth, OOUI shell, audit/crypto) → Phase 1 studies & documents → Phase 2 participants & recruitment → Phase 3 sessions/reminders/comms (first usable release) → Phase 4 data & compensation → Phase 5 polish. Nightly `pg_dump` to versioned S3 is a hard requirement, not an afterthought.

## Updating This File

Once implementation starts, replace the "Planned" framing above with actual commands (build, test, lint, migrations, local dev setup) and document any divergences from the spec here and in the spec's Decision Log.
