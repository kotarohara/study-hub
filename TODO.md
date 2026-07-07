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

- [x] 2.1 Participant + ContactChannel schemas (encrypted PII columns), demographics, do-not-contact flag, participation history
      Pool at `/participants` (visible to all members; mutations assistant+). `encryptedText`
      directly in schema for name/notes/channel values; pseudonymous `P-xxxxxxxx` codes.
      PII views audited at the HANDLER level (`pii.view`, `pii.list_viewed`), mutations audited
      in `lib/objects/participants.ts` with codes only. Detail tab "History" is a placeholder
      until enrollments (2.5). Channel verification flag exists; verification flows come with
      Telegram pairing (3.7).
- [x] 2.2 Cross-study deduplication warnings on participant create/import
      Keyed blind index (HMAC-SHA256, `PII_INDEX_SECRET`, never rotate without re-indexing)
      over normalized `kind:value` in `lib/crypto/blind_index.ts` — warns on create
      (confirm-anyway, never hard-blocks) + passive banner on the detail page.
      ⚠ The "import" half re-applies when the CSV importer lands (Phase 4).
- [x] 2.3 Simple-form builder Instrument (item types, no branching) + versioning + scoring rules; external-instrument records (Qualtrics links)
      Lab-wide library at `/instruments` (authoring researcher+). Form model in
      `lib/objects/forms.ts` (Zod): short/long text, number, single/multi choice, likert;
      scoring rules (sum/mean, likert reverse-scoring); `validateResponse`/`scoreResponse`
      ready for screeners (2.4) and EDA (Phase 4). Builder is the `FormBuilder` island
      serializing JSON into hidden inputs (server re-validates); `FormRender` renders
      previews now and participant forms in 2.4. Versioned like documents: revisions
      require a change note, old versions frozen. Study attachment (Usage tab) lands
      with screeners in 2.4.
- [x] 2.4 Public screener pages at `p/[token]`: Turnstile (stubbed in dev) + rate limits; eligibility rules → Enrollment status
      One screener per study (configured at `/studies/[id]/screener`, researcher+; pause/resume
      assistant+): pins an instrument version, eligibility rules (`lib/objects/eligibility.ts`,
      ANDed min/max + anyOf) validated against it. Public page `p/[token]/screener` (opaque
      128-bit token; live only while status=open AND study recruiting AND not pilot — spec §3.3
      no-public-recruitment enforced in domain + page). Turnstile adapter stubs locally, fails
      closed in unconfigured production; in-process rate limit on POST. Submissions create a
      memberless pool Participant (encrypted PII, source "screener") + Enrollment
      (eligible/screened by rules) + response row atomically; eligibility never revealed to the
      participant; `views` counter feeds funnel stats (2.7).
- [x] 2.5 Enrollment lifecycle (screened → eligible → consented → active → completed/withdrawn/excluded) + pilot-enrollment flag
      Explicit transition map in `lib/objects/enrollments.ts`; withdrawn/excluded/completed are
      terminal; every transition audited in-transaction with the pseudonymous code. Manual
      enrollment from the pool on the study "Participants" tab (assistant+; DNC participants
      blocked; one enrollment per participant per study). Pilot flag: forced for Internal Pilot
      studies, optional dry-run flag otherwise (researcher+ toggle, frozen once terminal).
      Assignment engine (1.4) wired: assign-condition action on consented/active enrollments,
      random-balanced or manual sequence per design, pilot enrollments balanced separately,
      one audit event per assignment. Participant "History" tab + instrument "Usage" tab filled
      in. "Record consent" stays a manual transition until the consent flow (2.6).
- [x] 2.6 Consent flow: page rendered from approved Document version, e-signature (encrypted), consent-to-recontact flag, re-consent on amendment
      `consents` rows pin (document, version); history immutable — amendments (new APPROVED
      version) flip status to "outdated" and re-consent inserts a new row. Participant page
      `p/[token]/consent` via purpose-scoped expiring magic link (14 days; rate-limited; no
      Turnstile — not an open form); typed-name e-signature encrypted at rest; first consent
      auto-advances eligible→consented in the same transaction; both audit events actorId null.
      Lab side: consent column + link issuance (audited) on the Participants tab; links shown
      for manual copy until messaging (3.x) delivers them. ⚠ File-only consent documents can't
      render on the participant page (text content only) — upload-based consent forms need the
      file route made participant-safe later.
- [x] 2.7 Recruitment funnel stats per channel + quota dashboard (per-stratum counts vs targets; manual pause)
      "Recruitment" tab on the study page: cumulative funnel (viewed from screener views;
      screened/eligible/consented/completed approximated by CURRENT enrollment status — history
      not replayed), per-channel breakdown (participant `source`), per-condition quotas vs
      ceil(targetN / #conditions) with full-quota highlighting, and the manual screener
      pause/resume (auto-pause cut per spec). Pilot enrollments excluded from every number,
      reported separately. ⚠ Divergence: quotas are per CONDITION + overall; demographic
      *strata* quotas need a stratum-definition feature that doesn't exist — revisit if needed.
- [x] 2.8 Re-recruitment: pool filtering + bulk invites via preferred ContactChannel
      `/studies/[id]/recruit` (assistant+): filter the pool by gender/birth-year/source with a
      consent-to-recontact guard ON by default (latest consent anywhere must allow recontact;
      untick for never-consented fresh entries). DNC and already-enrolled are always excluded.
      Bulk invite creates screened enrollments (per-enrollment audit + one summary event with
      codes only) and renders a run sheet of preferred channels (preferred flag, else oldest)
      for manual sending — audited as a pii.view. ⚠ "Invite" = enrollment + run sheet until
      the messaging core (3.3+) delivers automatically.

## Phase 3 — Sessions, Reminders & Comms *(first usable release)*

- [x] 3.1 Session scheduling: slot publishing, self-booking via magic link, reschedule/no-show tracking
      `study_sessions` table (domain "Session"; distinct from the auth `sessions` table) with
      lifecycle open → booked → completed/no_show/cancelled (+ booked→open on unbook). Study
      "Sessions" tab (researcher+ publishes slots; assistant+ books on behalf, marks
      completed/no-show, unbooks; researcher+ cancels). Self-booking page `p/[token]/book` via
      purpose-scoped "booking" magic link (30-day TTL, rate-limited, no Turnstile): participant
      books an open slot or moves their booking (atomic `rescheduleBooking`), or cancels.
      Booking is an atomic claim (re-checks status=open under the update) so two participants
      can't grab one slot; pilot flag inherited from the enrollment. Booking-link issuance
      (`/enrollments/[id]/booking-link`, assistant+, audited). All session events audited with
      the pseudonymous code only. datetime-local inputs interpreted in server tz (ap-southeast-1).
      ⚠ Single active booking per enrollment in the self-book UI (multi-session studies book
      lab-side); ICS feeds are 3.2; automated link delivery is 3.6.
- [x] 3.2 ICS feed generation + tests
      Pure RFC 5545 builder in `lib/calendar/ics.ts` (UTC times, TEXT escaping, 75-octet line
      folding, CRLF) — fully unit-tested. Two feeds, both pseudonymous (no PII): participant
      subscribable feed `p/[token]/calendar.ics` behind a long-lived (1yr) purpose-scoped
      "calendar" magic link (calendar apps poll cookie-less, so the token is the capability;
      excludes open slots, summary = study name); study feed `studies/[id]/calendar.ics`
      (member-gated download — every session, open slots labelled, booked rows show the
      pseudonymous code, cancelled → STATUS:CANCELLED, SEQUENCE bumps on reschedule). Subscribe
      link surfaced on the booking page; .ics download link on the Sessions tab.
      ⚠ Member feed is a signed-in download, not a cookie-less subscription URL (a member-scoped
      token feed could be added later if calendar-app subscription for staff is wanted).
- [x] 3.3 Messaging core: Message object, `ChannelAdapter` interface, templates with merge fields, delivery log
      `messages` delivery-log table (migration 0017): channel/templateKey/status/attempts plaintext,
      but recipient + subject + body encrypted at rest (they carry PII), `idempotencyKey` unique for
      at-most-once enqueue. `ChannelAdapter` interface + registry in `lib/integrations/channel.ts`
      (email/telegram/discord), with a no-network `FakeAdapter` for dev/tests; real adapters register
      in 3.4/3.7/3.9. Message templates with merge fields in `lib/objects/message_templates.ts`
      (reuses `renderTemplate`; a message must fully resolve — unfilled placeholder = error, never
      literal "{{…}}" sent). `lib/objects/messaging.ts`: `enqueueMessage` (render→encrypt→log,
      idempotent on key), `deliverMessage` (adapter send → status/attempts/providerId/error/sentAt,
      idempotent once sent, clean failure when no adapter), `listMessagesOfEnrollment` (non-PII log
      view). Pure template/adapter unit tests + integration test (encrypted-at-rest, idempotency,
      success/failure/no-adapter, no-PII log). ⚠ Backend only — delivery-log UI + real sends land
      with 3.6; the job runner that drives enqueue/deliver on a schedule is 3.5.
- [x] 3.4 Email adapter: SMTP (Mailpit) for dev, SES for prod behind same interface; bounce-webhook route (`hooks/ses-bounces.ts`) tested with simulated SNS payloads
      Hand-rolled SMTP client (`lib/integrations/smtp.ts`, no node deps to keep the vite SSR
      bundle clean): plain for Mailpit, STARTTLS+AUTH LOGIN when SMTP_USERNAME is set (SES).
      `EmailAdapter` (`lib/integrations/email.ts`) builds an RFC 5322 base64 message (pure
      `buildEmail` + MIME encoded-word subjects) and registers into the channel registry at
      startup (main.ts) — same code path both backends. SES bounce webhook at
      `routes/hooks/ses-bounces.ts` (added `/hooks/` to PUBLIC_PATHS; guarded by ?token= when
      SES_WEBHOOK_TOKEN set): pure SNS parser (`lib/integrations/ses_bounce.ts`) handles
      SubscriptionConfirmation + Notification, suppressing only PERMANENT bounces + complaints.
      `suppressEmailChannels` matches addresses by blind index (no plaintext in query/audit),
      flags the new `contact_channels.suppressed` column (migration 0018), audits with reason
      only. Config: SMTP_USERNAME/PASSWORD, SES_WEBHOOK_TOKEN (all optional, empty in dev).
      Tests: pure (buildEmail, SNS parser w/ simulated payloads), SMTP→Mailpit round-trip via
      Mailpit API, suppression integration (blind-index match, per-channel, no-PII audit).
      ⚠ STARTTLS+AUTH path is prod-only (not exercised by local Mailpit); suppressed channels
      are recorded now, enforcement at send time wires in with reminders (3.6).
- [x] 3.5 Job infrastructure: `Deno.cron` + `jobs`/`messages` tables, idempotency keys, retries with backoff, failure alerts via notification adapter + tests (incl. duplicate-send prevention)
      Message runner (`lib/jobs/message_runner.ts`) drains the queue: selects due messages
      (queued, or failed with attempts<MAX and past backoff), delivers via the registered
      adapter, applies exponential backoff (`backoffMs`: 1m→2m→4m… capped 1h, on the new
      `messages.next_attempt_at` column), and fires a failure alert after MAX_ATTEMPTS (5).
      Duplicate-send prevented two ways: enqueue idempotent on `idempotencyKey`, and
      `deliverMessage` no-ops once `sent` (runner never selects `sent`). `nextAttemptAt` also
      lets a message be enqueued for future delivery (scheduled reminders, 3.6). Generic `jobs`
      table + `runJobOnce` (migration 0019): unique-key claim runs a scheduled window at most
      once (for 3.6 reminder windows), recording status/attempts/error; a throwing job is logged
      failed + alerted, never crashes the cron. Pluggable `AlertSink` (`lib/jobs/alerts.ts`,
      console default; Discord wires in at 3.9). `registerMessageCron` (every minute, gated by
      JOBS_ENABLED + --unstable-cron) in main.ts. Pure tests (backoff, alert routing) + integration
      (deliver/retry-backoff/permanent-fail+alert, scheduled-hold, no re-send; runJobOnce once +
      skip-on-repeat + failure alert).
- [x] 3.6 Session reminders + booking confirmations end-to-end (visible in Mailpit) — `lib/objects/notifications.ts`:
      `notifyBookingConfirmed` (called after booking on both the lab route `sessions/[id]/book.ts` and the
      participant self-book/reschedule route `p/[token]/book.tsx`) and `sweepDueReminders` (a periodic sweep
      reading live session state — reschedules/cancellations are handled for free, idempotent per session via
      `confirm:`/`reminder:` keys). Both enforce the compliance gates deferred from 3.1/3.4: do-not-contact and
      bounce-suppressed channels are skipped. The message cron (3.5) sweeps reminders then drains the queue each
      minute. Study Sessions tab gains a pseudonymous "Message log" (`components/MessageLog.tsx` + `listMessagesOfStudy`
      — participant code only, no PII). End-to-end test proves a confirmation lands in Mailpit via the real EmailAdapter.
- [x] 3.7 Telegram adapter: webhook route, pairing deep link (one-time token → verified ContactChannel), reminders, `/stop` → email fallback; tested with simulated Bot API payloads —
      `lib/integrations/telegram.ts` (`TelegramAdapter` over an injectable transport so the Bot API is testable
      without network; `pairingDeepLink`, `toSendResult`), `lib/integrations/telegram_update.ts` (pure `parseUpdate`
      of Bot API updates → `/start <token>` / `/stop` / other / ignore), and `lib/objects/telegram.ts` (pairing
      domain: `telegramPairingToken`/`telegramDeepLink` (purpose `telegram_pair`, 7-day TTL), `pairTelegram`
      (one-time token → verified, un-suppressed telegram ContactChannel; idempotent re-pair), `stopTelegram`
      (suppress by blind index → email fallback), and `handleTelegramUpdate` orchestrating the webhook reply).
      Webhook at `routes/hooks/telegram.ts` (secret-header guarded, thin shell, always 200); researcher pairing-link
      page at `routes/participants/[id]/telegram-link.tsx` surfaced from the participant Channels tab. Notification
      resolution generalized: `resolveContact` prefers a verified Telegram chat over email (skip reason now
      `no_channel`), and the message runner delivers via the channel's registered adapter. Config gains
      `TELEGRAM_BOT_TOKEN`/`_USERNAME`/`_WEBHOOK_SECRET` (empty token = Telegram disabled; adapter registered in
      `main.ts` only when set). Tests: adapter/parser/deep-link units with simulated payloads; pairing/stop/webhook
      integration; and a notification channel-preference test (Telegram chosen, `/stop` falls back to email).
- [x] 3.8 Diary/ESM engine: schedule builder (fixed/interval/randomized windows), prompt dispatch, diary entry pages via magic link, optional quick replies —
      `lib/objects/diary_schedule.ts` (pure, exhaustively tested `buildPromptTimes`: fixed times / interval stepping /
      randomized with injectable RNG + min-gap guarantee; `parseDiaryConfig` validates per window type; times are UTC
      "HH:MM", documented). Domain in `lib/objects/diary.ts`: `configureDiary` (one schedule/study, pins the
      instrument version), `generatePrompts`/`generatePromptsForActive` (idempotent per enrollment — never doubles
      windows), `sweepDueDiaryPrompts` (cron tick mirroring `sweepDueReminders`: expires stale windows → `missed`,
      dispatches due prompts as `diary_prompt` messages carrying a magic link, idempotent `diary:<id>`; reuses the
      shared `resolveContact` so Telegram/email + do-not-contact/`/stop` all apply), and `submitDiaryEntry` (validated
      against the pinned form, one `diary_response`, refuses closed windows, idempotent re-submit). New tables:
      `diary_schedules`, `diary_prompts`, `diary_responses` (migration 0020); answers are jsonb tied to a pseudonymous
      enrollment (never PII, like screeners). Participant entry page `routes/p/[token]/diary.tsx` (purpose "diary"
      magic link; one-tap **quick replies** opt-in for single-question diaries). Study "Diary" tab
      (`components/DiaryPanel.tsx`) configures the schedule, generates prompts, and shows pseudonymous per-participant
      progress; cron wired in `message_cron.ts`. Tests: pure builder/parser units + integration (configure, generate
      idempotency, dispatch-once/expire/unreachable, submit validation/closed/re-submit, progress, end-to-end delivery).
- [x] 3.9 Discord webhook adapter (internal events; pseudonymous IDs only — assert no PII in payloads via test) —
      `lib/integrations/discord.ts`: outbound webhook POSTs to a lab channel (no bot/gateway/slash commands, all cut
      per spec §5.4) over an injectable transport (fake-testable, no network). Two roles: (1) a real **AlertSink**
      (`discordAlertSink`) wired in `main.ts` so background-job / backup / message-delivery failures ping Discord
      when `DISCORD_WEBHOOK_URL` is set (else they stay on the console); (2) `notifyDiscordEvent` for lab events —
      a `DiscordEvent` union (enrollment eligible, session booked/cancelled/no-show, milestone due, IRB expiring,
      payment pending) that **by construction carries only pseudonymous codes + internal study names — no field
      for a name/email/phone/chat id**. Fire-and-forget, no-op when unconfigured, never throws. Wired into
      `screeners.submitScreener` (new eligible participant) and `sessions.ts` (booked/cancelled/no-show), guarded by
      `discordConfigured()` so there's zero cost when off. Config gains `DISCORD_WEBHOOK_URL`. Tests
      (`discord_test.ts`): the **no-PII invariant** (every event kind serialized, asserting participant
      name/email/phone/Telegram handle never appear), formatter output, transport success/non-2xx/throw handling,
      and the alert sink. **Phase 3 (first usable release + comms) complete.**

## Phase 4 — Data & Compensation

- [x] 4.1 Dataset object + file uploads to FileStore; pseudonymous linkage (record → participant ID + condition + session); pilot-data exclusion by default + tests —
      `datasets`/`dataset_records`/`dataset_files` (migration 0021). Records carry a jsonb payload (research data
      only, never PII) linked by enrollment; participant code + condition resolve at read time, optional session.
      `is_pilot` is inherited from the enrollment AT INSERT TIME (promoting a pilot later never un-quarantines old
      rows) and `listRecords` excludes pilot by default. `sourceKey` gives provenance + idempotency (unique per
      dataset). Files upload through the study "Data" tab → dataset detail page (`routes/datasets/[id]/`) into the
      FileStore (MinIO/S3), downloads via audited presigned URLs. Tests: create/unique/ensure, pilot inheritance +
      quarantine, sourceKey dedup, linkage resolution, FileStore roundtrip.
- [x] 4.2 Form responses captured as Dataset records — `captureResponse` writes into the well-known "Responses"
      dataset (auto-created, attributed to the study creator), called INSIDE the same transaction as
      `submitScreener` (`screener:<enrollmentId>`) and `submitDiaryEntry` (`diary:<promptId>`) so a response and its
      dataset record land or fail together. Assertions added to the screener + diary integration tests (payload
      matches answers, pseudonymous, no PII).
- [x] 4.3 Generic CSV/JSON importer with column-mapping UI; codebook generation — `lib/objects/importer.ts`:
      hand-rolled RFC-4180 CSV parser (quoted fields, "" escapes, CRLF, ragged rows) + JSON-array parser, both pure
      and exhaustively unit-tested; `applyMapping` (code column → linkage, selected columns → data, numeric
      coercion; the code column never becomes row data); `importIntoDataset` resolves codes → enrollments of the
      study, keeps unmatched rows unlinked and reports their codes, idempotent per `import:<fileId>:<row>` (re-import
      is a no-op). Flow: upload the CSV/JSON to the dataset's file shelf → "Import rows →" opens the column-mapping
      page (`routes/datasets/[id]/import.tsx`, researcher+, audited) → result notice on the dataset page.
      `lib/objects/codebook.ts` (pure `buildCodebook`): per-variable type inference (number/string/array/mixed),
      missingness, distinct-value inventory (≤20 listed), numeric min/max/mean; rendered on the dataset page over
      the pilot-quarantined view and shipped with exports in 4.5.
- [x] 4.4 EDA islands (client-side, ≤100k rows): summary stats, histograms/box plots, group-by-condition, scale
      auto-scoring — `lib/eda/stats.ts` (pure: R-type-7 quantiles, `numericSummary`, fixed-width `histogram`,
      `summarizeByGroup`, numeric-column detection) drives `islands/EdaCharts.tsx`: variable picker → stats table +
      SVG histogram + per-condition box plots, all computed in the browser over the serialized records.
      `routes/datasets/[id]/eda.tsx` serializes the pilot-quarantined view (≤100k rows; pilot rows never reach the
      browser) with condition linkage. Scale auto-scoring (`lib/eda/scale_scores.ts`): the study's screener/diary
      instruments' scoring rules become derived `scale_<rule>` columns (deterministic derivation server-side;
      partial scales score null and are skipped). Pure tests for stats + scale derivation.
- [x] 4.5 Export: CSV/JSON; profiles full (PI-only) / de-identified / OSF-ready; analysis-ready bundle (data +
      codebook + R/Python loader); export audit + tests proving PII never leaks into de-identified profiles —
      `lib/export/`: `profiles.ts` defines the three levels (full: stable codes + condition + session/provenance
      metadata, PI-only because stable codes enable cross-study joins, pilot rows only on explicit request and
      flagged; de_identified: fresh per-export ids `P001…` assigned in shuffled order, rows shuffled, all metadata
      dropped, pilot always excluded; osf: de-identified minus open-ended text columns — string columns with >20
      distinct values, where self-identifying detail hides). `csv.ts` (RFC-4180 serializer), `zip.ts` (hand-rolled
      store-only ZIP + CRC-32, proven extractable by system `unzip` in tests), `bundle.ts` (data.csv +
      codebook.json + load.R + load.py + README). Route `routes/datasets/[id]/export.ts` gates full to PI, audits
      `export.create` BEFORE bytes leave. Tests: profile semantics with injected RNG (same person ⇒ same fresh id,
      no metadata/stable codes), OSF column dropping, CSV quoting, ZIP roundtrip, and a DB test with a real
      encrypted participant proving name/email/stable-code never appear in de-identified/OSF output.
- [x] 4.6 Compensation object (amount, scheme, method, status pending → approved → paid); outstanding-payments
      dashboard — `compensations` table (migration 0022): integer cents (SGD default), scheme, method
      (paynow/paypal/prolific/cash/voucher), enforced pending → approved → paid lifecycle with approver/payer +
      timestamps, transfer `reference`, `prolific_submission_id`. Approvals (`payment.approve`) and payouts
      (`payment.paid`) audited; races guarded by status-conditional updates. `/payments` dashboard (new nav item):
      every unpaid compensation lab-wide oldest-first with approve (researcher+) / mark-paid (assistant+) actions,
      totals (pending / approved, approved-by-method = each run sheet's size), and an add-compensation flow
      (study → enrollment picker, SSR).
- [x] 4.7 PayNow/PayPal run sheets + mark-as-paid; Prolific ID tracking; payment confirmations to participants —
      `lib/objects/ledger.ts` `runSheet(method)`: approved-unpaid rows with decrypted name + payment address
      (PayNow phone / PayPal email / Prolific ID from ContactChannels; missing channels surface as empty payTo, not
      silently dropped). CSV at `/payments/runsheet?method=` — PII-bearing → **PI-only**, audited `pii.export`
      before bytes leave. Close-out: "mark all paid" per method with a shared transfer reference (`markBatchPaid`,
      only approved rows flip, each payout audited). Every mark-paid enqueues an idempotent `payment_confirmation`
      message (`payment:<id>`) through the same channel resolution + compliance gates as reminders.
- [x] 4.8 Ledger export (Name / Phone / Amount), PI-gated + audited + tests — `/payments/ledger`: every PAID
      compensation with the spec-fixed columns Name / Phone Number / Compensation Amount (+ paid date, method,
      reference). PI-only; `pii.export` audit written before the response. Tests cover decrypted run-sheet values,
      ledger columns, and gating-by-status.
- [x] 4.9 Withdrawal workflow (action, data handling per consent) + retention timers + PI-approved purge —
      `lib/objects/withdrawal.ts`: `withdrawEnrollment` = the lifecycle transition PLUS everything it would leave
      dangling — scheduled/sent diary prompts cancelled, future booked sessions freed back to open, and collected
      data handled per the signed consent ("retain" keeps it pseudonymously; "delete" removes the enrollment's
      dataset records, diary responses, and screener answers). Audited with counts. The EnrollmentPanel "Withdraw"
      button now opens the workflow page (`routes/enrollments/[id]/withdraw.tsx`) instead of a bare transition.
      Retention timer: `purgeCandidates` (every enrollment terminal + inactive past a window, default 3 years) on
      the PI-only `/participants/retention` page; `purgeParticipant` (PI-approved, per row, confirmed) erases PII —
      channels deleted, name overwritten to "[purged]", demographics cleared, do-not-contact set — while the
      pseudonymous code, enrollments, and research records survive so datasets stay reproducible. Audited
      (`participant.purged`, code only), irreversible, purged participants never re-list. Tests cover obligations
      cancellation, retain-vs-delete, candidate gating, purge semantics, and no-PII audit trails.
      **Phase 4 (data & compensation) complete.**

## Phase 5 — Polish (still local)

- [x] 5.1 Notion one-way push adapter (fake impl + payload tests; no PII assertion) + Notion-page links as
      Documents — `lib/integrations/notion.ts` (injectable transport; `formatStudyProperties` builds the row from a
      `StudySnapshot` that BY CONSTRUCTION carries only study-level fields + aggregates — no field for a name,
      email, code, or channel; no-PII test asserts it) + `lib/objects/notion_push.ts` (`pushStudyToNotion`: builds
      the snapshot from live funnel + milestones, creates the row on first push, updates the same page after —
      `studies.notion_page_id`, migration 0023 — audited `study.notion_pushed`). "Push to Notion"/"Update Notion
      row" button on the study Overview tab, shown only when `NOTION_API_TOKEN` + `NOTION_DATABASE_ID` are set.
      Notion-page links as Documents: `document_versions.external_url` (same migration) — a version is now exactly
      one of text/file/link, validated http(s); forms accept a URL and the document page renders the link.
- [ ] 5.2 Health dashboard: funnel vs target N, upcoming sessions, overdue tasks
- [ ] 5.3 Accessibility pass on participant-facing pages (WCAG 2.1 AA)
- [x] 5.4 Security review of PII flows: verify every PII read/export path is role-gated + audited; pen-test magic
      links (expiry, purpose confusion, tampering) — `docs/security-review.md` documents the PII-path gate/audit
      matrix and the token model. **Finding fixed**: the participant pool list (`/participants`) and detail
      (`/participants/[id]`) rendered decrypted names/channels but were gated only by "signed in" — a collaborator
      could view participant PII; both now require `assistant+` (matching edit/new/channel routes, spec §3.10).
      Pen tests (`lib/crypto/magic_link_pentest_test.ts`) attack the full purpose matrix: purpose confusion (a token
      verifies for its purpose only — cross-purpose always null), tampering (payload subject/purpose swaps with the
      original signature fail; truncated/flipped/missing signatures fail; foreign-secret tokens fail), and expiry
      (past-TTL rejected vs a valid control). Signature is checked timing-safe before payload parse, so error
      reasons leak nothing.
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
