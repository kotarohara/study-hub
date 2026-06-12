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
  - Turnstile → verification stub when `APP_ENV=development`
- **No test may require network access or real credentials.**
- `.env.example` documents every variable; dev defaults work out of the box.

---

## Phase 0 — Foundations (all local)

### 0.1 Scaffold
- [x] Initialize Fresh 2 project; `deno.json` tasks: `dev`, `test`, `check` (fmt+lint+types), `db:migrate`, `db:seed`
      — Fresh 2.3.3 with the Vite setup (current default). `db:migrate`/`db:seed` deferred to 0.2
      when the scripts exist; added `stack:up`/`stack:down` tasks for the compose stack.
- [x] `compose.dev.yml`: Postgres 16 + MinIO + Mailpit, with healthchecks and volumes
      — plus a one-shot `minio-init` job that creates the dev buckets and enables versioning
      on `studyhub-backups` (mirrors prod S3).
- [x] `.env.example` + config loader (Zod-validated, fails fast on missing vars)
      — `lib/config.ts`; env var is `APP_ENV` (not `ENV`, which is reserved by POSIX sh).
      Dev/test fall back to compose.dev.yml defaults so a fresh checkout needs no .env;
      production requires every var explicitly.
- [x] `/health` route (checks DB + storage connectivity) — `routes/health.ts` + `lib/health.ts`
- [x] GitHub Actions CI: `deno task check` + `deno test` against service containers
      — uses `docker compose -f compose.dev.yml up --wait` (same stack as dev) rather than GHA
      service containers; also runs `deno task build` (vite). CI is the verification path for
      anything needing JSR or container pulls when the dev sandbox blocks those hosts.

### 0.2 Data layer + backups
- [x] Drizzle ORM setup: connection pool, migration runner, first migration (members table as guinea pig)
      — `lib/db/{schema,client,migrate}.ts`; migrations generated with drizzle-kit
      (`deno task db:generate`, works under Deno) into `drizzle/`; applied via `deno task db:migrate`.
- [x] Test helpers: per-test transaction rollback or template-DB reset; fake-data factories
      — `withRollback` (transaction rollback) in `lib/db/test_util.ts`; faker factories in `lib/db/factories.ts`.
- [x] Seed script with realistic fake data (faker), runnable via `deno task db:seed`
      — deterministic (seeded faker), idempotent (onConflictDoNothing), refuses production.
- [x] `FileStore` interface + S3-API implementation (works against MinIO and real S3); presigned upload/download URLs; tests against MinIO
      — `lib/storage/filestore.ts` (AWS SDK v3, path-style); per-bucket instances (files/backups).
- [x] `scripts/backup.sh`: `pg_dump` → versioned bucket (MinIO locally); `scripts/restore.sh`; automated test that backs up, drops, restores, verifies
      — implemented in TypeScript instead of shell (`deno task db:backup` / `db:restore`, core in `lib/backup.ts`):
      portable and directly testable. Full backup→data-loss→restore→verify cycle in `lib/backup_test.ts`;
      requires pg_dump/pg_restore on PATH. Drill doc: `docs/backup-restore-drill.md`.
- [x] Backup job wiring via `Deno.cron` (interval configurable; manual-trigger route in dev)
      — `BACKUP_CRON_ENABLED` + `BACKUP_CRON` env knobs (schema-level defaults); `--unstable-cron` on the
      start task; dev-only manual trigger `POST /api/dev/backup`. Discord failure alerts deferred to 3.3.

### 0.3 Crypto & tokens
- [x] AES-256-GCM field encryption helpers (encrypt/decrypt, key from env, versioned key id for future rotation) + tests incl. tamper detection
      — `lib/crypto/encryption.ts`; node:crypto (sync, required by Drizzle custom types); keyring env
      `PII_ENCRYPTION_KEYS` = `<version>:<base64 32B key>` pairs, highest version encrypts; stored
      format `enc:v<n>:<iv>:<ct>:<tag>`. Tests cover tamper (all parts), rotation, wrong-key, malformed.
- [x] Drizzle custom column type for encrypted PII fields
      — `encryptedText` in `lib/db/encrypted.ts` (kept out of schema.ts so drizzle-kit loads cleanly);
      integration test proves plaintext through Drizzle, ciphertext at rest.
- [x] HMAC magic-link tokens: sign/verify with expiry + purpose scoping + tests
      — `lib/crypto/magic_link.ts`; HMAC-SHA256, base64url `payload.sig`, timing-safe compare,
      signature checked before payload parse; `MAGIC_LINK_SECRET` env (min 32 chars). One-time-use
      tokens (Telegram pairing) need server-side state — deferred to 3.4.

### 0.4 Auth & members
- [x] Members schema + Argon2id hashing + login/logout routes + session cookies (HttpOnly, Secure, SameSite); CSRF tokens
      — Argon2id via @node-rs/argon2 (OWASP params); server-side sessions table storing SHA-256 token
      hashes (30d TTL, prune helper); `/login` + `/logout`; Secure flag in production only (dev is http).
      CSRF: Fresh's built-in `csrf()` middleware (Origin/Sec-Fetch-Site validation) instead of
      hand-rolled tokens — the modern equivalent. Timing-safe login (dummy-hash verify on unknown email).
- [x] PI-invite flow (invite token → set password); no self-signup
      — `invites` table (hashed tokens, 7d TTL, atomic single-use claim); `POST /api/invites` (PI-only,
      returns link; emailing arrives with Phase 3.2 messaging) → `/invite/[token]` set-name/password page,
      auto-login on accept. Seeded dev accounts (pi@studyhub.local etc.) log in with `studyhub-dev`.
- [x] Role middleware (PI > Researcher > Assistant > Collaborator) + route guards + tests
      — `hasRole` hierarchy + `sessionMiddleware` (global, resolves cookie → ctx.state.member) +
      `requireMember(minRole)` guard (redirects browsers to /login, 401/403 for API clients).
- [x] Rate limiting middleware on auth + public routes (in-process token bucket)
      — `lib/rate_limit.ts` token bucket (+ prune); applied to login + invite-accept POSTs per client IP;
      `rateLimit()` middleware factory ready for public `p/` routes in Phase 2.

### 0.5 Audit log
- [x] Append-only `audit_log` table (no UPDATE/DELETE grants) + write helper
      — REVOKE alone cannot bind the table owner, so immutability is enforced with BEFORE
      UPDATE/DELETE/TRUNCATE triggers that raise (migration 0002) + REVOKE from PUBLIC.
      `audit()` helper in `lib/audit/log.ts`; actor_id has no FK so entries outlive members.
- [x] Audit middleware covering: PII views/exports, consent changes, deletions, payment approvals + tests proving append-only behavior
      — `createAuditMiddleware(rules)` (URLPattern-based, logs after 2xx/3xx; matcher unit-tested)
      wired in main.ts; handler-level `audit()` calls for actions that must not go unrecorded
      (login success/failure, invite create/accept). PII-view/export/consent/payment rules get
      added to AUDIT_RULES as those routes land (Phases 2/4). Integration tests prove UPDATE,
      DELETE, TRUNCATE and raw-SQL tampering are all rejected by the database.

### 0.6 OOUI shell
- [x] App layout: global nav listing object collections, design tokens, status-badge component
      — `components/Layout.tsx` (sidebar of object collections from `lib/ooui/nav.ts`, items enable
      as phases land) + Tailwind 4 `@theme` tokens (brand palette + loud pilot tone) +
      `StatusBadge` driven by `lib/ooui/status.ts` tone map. App routes auth-gated by
      `routes/_middleware.ts` (public: login/invite/health/p/*). `/` is now the dashboard.
- [x] Reusable **collection view** (filter/sort/paginate at 50, bulk-action slots)
      — `CollectionView` (server-rendered; links + GET forms, no island needed) over pure helpers
      in `lib/ooui/collection.ts` (in-memory filter/sort/paginate — push to SQL when a collection
      outgrows lab scale). Exercised by `/members`.
- [x] Reusable **detail view** (identity header, property panel, related-object tabs, action bar gated by lifecycle state)
      — `DetailView` + `ActionBar`; exercised by `/members/[id]` (Overview/Activity tabs — Activity
      lists the member's audit entries; PI-or-self "revoke sessions" action, audited).
- [x] Reusable **inline/compact chip/card** view — `Chip` (drag-and-drop arrives with the islands
      that need it).
- [x] Generic CRUD + duplicate + archive action plumbing shared across object types
      — `lib/ooui/actions.ts`: ObjectAction + resolveActions() gating by lifecycle state and role
      (disabled actions render with a reason). Components are Fresh-free Preact, render-tested
      locally with preact-render-to-string. Concrete duplicate/archive semantics land with the
      first lifecycle objects (1.1/1.2). Invite UI at `/members/invite` (PI-only).

## Phase 1 — Studies & Documents

- [x] 1.1 Project CRUD + membership (collection/detail views, archive)
      — `projects` + `project_members` tables (migration 0003); domain logic in `lib/objects/projects.ts`
      with visibility rules (PI sees all, others only assigned projects) and audited mutations
      (create/update/archive/unarchive/member add+remove — membership changes are idempotent and
      only audit real changes). Routes: `/projects` collection, `/projects/new`, `/projects/[id]`
      (Overview/Members/Studies tabs; Members tab has chip list + add/remove for researcher+),
      `/projects/[id]/edit`, archive/unarchive POSTs. Archive makes the project read-only (edit and
      membership changes are refused at both the action-gating and handler level). Member detail
      Overview now shows the member's project chips. Creator auto-joins their project. Seed adds an
      "Example Project". Project create permission: researcher+.
- [x] 1.2 Study CRUD: lifecycle states (draft → IRB review → recruiting → running → analysis → archived) + stepper; state-gated actions; duplication (design + docs + timeline, minus participants/data)
      — `studies` table (migration 0004) with methodology + `oversight_pathway` column (creation
      locked to irb_reviewed until the 1.6 selector) + `archived_from` (unarchive restores the
      prior state). Explicit, audited transition map in `lib/objects/studies.ts`; edit only in
      draft/irb_review; archive from any state; duplication copies the design into a fresh draft —
      extend `duplicateStudy` to copy documents (1.5) and milestones (1.9) when those land.
      Stepper component renders the lifecycle. Routes: `/studies`, `/studies/new?project=`,
      `/studies/[id]` (+ edit/transition/duplicate/archive/unarchive); project Studies tab live.
      ⚠ 1.7 must add the recruiting guard (approved consent Document) to the transition map.
- [x] 1.3 Design editor: structured fields (RQs, hypotheses, IVs/DVs, conditions, design type, target N, exclusion criteria) + one-pager render
      — design columns on `studies` (+ `counterbalancing_scheme` text per spec's Latin-square cut)
      and a `conditions` table (ordered, unique names per study; 1.4 assigns enrollments to these)
      — migration 0005. `lib/objects/design.ts`: updateDesign + condition add/remove, all gated to
      draft/irb_review and audited; duplicateStudy now copies design fields and conditions.
      Editor at `/studies/[id]/design` (list fields newline-separated); print-friendly one-pager
      at `/studies/[id]/onepager`; Design tab shows the summary.
- [x] 1.4 Condition assignment engine: random + manual counterbalanced assignment with audit trail + tests
      — engine is a pure, storage-free module (`lib/objects/assignment.ts`): balanced random
      (uniform among least-assigned → group sizes never differ by >1, injectable RNG) and manual
      counterbalanced sequences (validated names, cycled from a cursor). Per-study config
      (`assignment_strategy` + `assignment_sequence`, migration 0006) is part of the design
      (audited via design_updated, copied on duplicate, manual sequences validated at save);
      design editor has the selector + a seeded preview of upcoming assignments.
      ⚠ Deliberate deferral: Enrollments don't exist until Phase 2, so assignment-of-enrollment
      rows + per-assignment audit events are wired in **2.5** using this engine — no premature
      enrollment stub table was created.
- [x] 1.5 Documents: upload/create, version history + diff, review statuses, reviewer comments
      — `documents` + `document_versions` + `document_comments` (migration 0007). Versions are
      in-app text (diffable, LCS line diff in `lib/objects/diff.ts`) OR uploaded files (FileStore,
      10 MB cap, presigned download). Review workflow draft → internal_review → submitted →
      approved/revisions_requested with an explicit transition map; **recording approval is
      PI-only** (it will gate recruiting in 1.7); adding a version requires a change rationale and
      resets status to draft — approval never carries over. duplicateStudy copies study-attached
      documents (latest version → fresh v1 draft). Routes: `/documents` collection, `new`,
      `[id]` (Content/Versions/Comments tabs), `diff`, `transition`, `versions/new`, `download`;
      Documents tabs on project + study detail; nav enabled. Comments: assistant+.
- [x] 1.6 Oversight pathway selector: IRB-reviewed / IRB-exempt (reference required) / Internal Pilot (PI confirmation + justification → audit log; permanent PILOT badge; pilot data-quarantine flag)
      — `irb_exemption_reference` + `pilot_justification` columns (migration 0008);
      `validatePathway` enforces the rules (exempt needs reference; pilot needs PI + justification,
      both recorded in audit details). Selector on `/studies/new` (pilot option PI-only);
      `/studies/[id]/pathway` PI-only change page, locked once past draft/irb_review ("Promote to
      full study" in 1.8 is the way out after that). Duplicating a pilot is PI-only (it reproduces
      the no-IRB declaration). PilotBanner on study detail + one-pager; pilot badge on the studies
      collection and project-tab chips. `isPilotStudy()` is the quarantine flag for Phases 2/4
      (screener block + dataset/export exclusion enforced there).
- [x] 1.7 IRB workflow: merge-field document templates from Study fields, approval metadata (protocol #, dates), expiry warnings, recruiting guard (blocked until approved consent Document)
      — `lib/objects/templates.ts`: `{{merge_field}}` rendering + built-in consent/protocol starter
      templates; substitution happens when PREFILLING the editor (links on /documents/new with a
      study context), so stored text never silently changes with the design. IRB metadata
      (protocol #, approved/expires dates, migration 0009) recorded PI-only at /studies/[id]/irb,
      audited, NOT copied on duplication. `irbExpiryStatus` drives detail-page warning banners
      (30-day window); Discord/email expiry alerts arrive with jobs in 3.x. **Recruiting guard**
      in transitionStudy: irb_reviewed studies need an APPROVED consent_form document AND an
      unexpired IRB approval to enter recruiting (exempt/pilot unaffected).
- [x] 1.8 "Promote to full study" action (duplicate into fresh IRB-reviewed Study, zero data carry-over) + tests
      — `promoteToFullStudy` (pilots only, researcher+ since the result is the standard pathway):
      shares `copyStudyTx` with duplicate; copies design/conditions/documents into a fresh
      irb_reviewed draft named "… (full study)" with no pilot justification and no IRB metadata.
      The pilot itself is untouched (archive it separately). Audited as `study.promoted`.
      Primary action with confirm on pilot study detail pages.
- [x] 1.9 Milestones/Tasks: CRUD, dependencies + blocking, methodology templates
      — `milestones` + `milestone_dependencies` (migration 0010): owner, start/due dates,
      pending/in_progress/done; "blocked" is DERIVED (unfinished dependency), never stored.
      Status changes refuse blocked milestones; dependencies are same-project only with pure
      cycle detection (`wouldCreateCycle`, unit-tested). Per-methodology templates insert a
      sequentially-dependent chain. Study Timeline tab (list + add + template button) and
      project Timeline tab (roll-up incl. study milestones + project-level add); shared
      `MilestoneList` component (render-tested). duplicateStudy copies the timeline (statuses
      reset to pending, dependencies remapped). Deletes and status changes audited.
      Status flips allowed for assistant+; structure changes researcher+.
- [x] 1.10 TimelineGantt island + project roll-up calendar
      — first client-side island (`islands/TimelineGantt.tsx`): milestones as bars on a
      month-scaled axis (status colors, blocked ring, today marker, undated listed below) with
      **drag-to-reschedule** (pointer events → whole-day snap → POST /milestones/[id]/reschedule
      → reload); geometry is pure + unit-tested in `lib/ooui/gantt.ts`. Project Timeline tab adds
      a server-rendered month calendar (Mon-based grid, prev/next via ?month=, due-dated
      milestones link to their study) over the roll-up list; calendar math pure + unit-tested in
      `lib/ooui/calendar.ts`. rescheduleMilestone is date-only with validation (integration test).

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
