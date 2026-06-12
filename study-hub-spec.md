# StudyHub — Specification
### A User Study Management System for HCI Research Labs
**Stack:** Deno + Fresh 2 on a single AWS instance (ap-southeast-1, Singapore) · **Design approach:** Object-Oriented User Interface (OOUI) · **Status:** Draft v0.5

**Key decisions (v0.5):** Minimal all-AWS footprint — **one Lightsail/EC2 instance + S3 + SES + Route 53** (RDS optional splurge) · single lab · **studies declare an oversight pathway: IRB-reviewed, IRB-exempt, or Internal Pilot (no IRB; PI-approved, badged, data quarantined)** · main surveys run in Qualtrics/Google Forms by design; StudyHub orchestrates and ingests CSV · participants use magic links only, with persistent Participant records for project-lifetime contact and re-recruitment · compensation via PayNow (manual + run sheet), PayPal, Prolific · ledger export = Name, Phone, Amount · Telegram + email for participants (WhatsApp adapter later) · Discord + Notion internal only.

---

## 1. Purpose & Context

A web application for a single HCI research lab (PI + graduate students + RAs) to manage the full lifecycle of user studies: online surveys, crowdsourcing tasks, lab experiments, diary studies, interviews, and field deployments. The system centralizes study preparation, IRB documentation, participant recruitment and management, data collection artifacts, and timelines — replacing scattered spreadsheets, Drive folders, and ad-hoc messaging.

**Philosophy (v0.4):** StudyHub *orchestrates* studies; it does not replace specialized tools. Qualtrics/Google Forms keep doing surveys, G*Power does power analysis, OSF does pre-registration. StudyHub is the system of record that connects participants, consent, scheduling, money, and data files.

**Primary users:** PI, student researchers, lab managers/RAs.
**Secondary users:** External collaborators (limited access), participants (no accounts; magic-link pages only: screeners, consent, scheduling, diary prompts).

---

## 2. OOUI Design Foundation

The UI is organized around **objects users recognize from their real work**, not around tasks or features. Users navigate to an object, see it represented consistently, and act on it via actions exposed on the object itself (noun → verb, never verb → noun).

### 2.1 Core object model

| Object | Description | Key relationships |
|---|---|---|
| **Project** | A research project; container for everything | has many Studies, Documents, Members |
| **Study** | One experiment/survey/diary study with a design + lifecycle state | belongs to Project; has Conditions, Sessions, Instruments, Datasets, Milestones |
| **Participant** | A person in the lab-wide participant pool; persists across studies for lifetime-of-project contact and re-recruitment | has Enrollments, Sessions, Compensations, Consents, ContactChannels |
| **ContactChannel** | A verified way to reach a Participant: email, Telegram chat ID, phone (PayNow / future WhatsApp), PayPal email, Prolific ID | belongs to Participant |
| **Enrollment** | A participant's involvement in one specific study (status: screened → eligible → consented → active → completed/withdrawn/excluded) | joins Participant ↔ Study |
| **Session** | A scheduled or completed data-collection encounter (lab slot, interview, diary window) | belongs to Study + Enrollment |
| **Instrument** | A *simple form* (screener, consent add-ons, diary entry) or a *link/record of an external instrument* (Qualtrics survey, interview guide doc) | used by Studies; versioned |
| **Dataset** | A logical collection of collected data (responses, logs, uploaded files) with a schema/codebook | belongs to Study |
| **Document** | IRB protocol, consent form, recruitment flyer, amendment, debrief script — versioned, with review status | belongs to Project or Study |
| **Compensation** | Money owed/paid for an Enrollment, with method (PayNow/PayPal/Prolific) and status | belongs to Enrollment |
| **Milestone / Task** | Timeline items with owners, due dates, dependencies | belongs to Study or Project |
| **Member** | A lab member account with a role | belongs to Projects |
| **Message / Notification** | Outbound communication (email, Telegram, Discord; later WhatsApp) with templates and delivery log | references Enrollments/Sessions |

### 2.2 OOUI principles applied

1. **Objects are first-class and navigable.** Global navigation lists object collections (Projects, Studies, Participants, Instruments, Documents), not features ("Recruitment", "Analysis").
2. **Consistent object views.** Every object type has exactly three view patterns:
   - *Collection view* — filterable/sortable table or card grid with bulk actions.
   - *Detail view* — identity header (icon, name, status badge), property panel, related-object tabs, action bar.
   - *Inline/compact view* — chip/card used when the object appears inside another object's detail view (clickable, drag-and-droppable).
3. **Actions live on objects.** "Send reminder" appears on a Session or Enrollment, not in a global "Reminders" menu. Context menus (right-click / ⋮) expose the same actions as the action bar.
4. **Direct manipulation.** Drag a Participant card onto a Session slot to schedule; drag an Instrument into a Study to attach it; drag Milestones on a Gantt/timeline to reschedule.
5. **State as visible object property.** Lifecycle states (Study: draft → IRB review → recruiting → running → analysis → archived) render as a status badge + progress stepper on the object, and drive which actions are enabled.
6. **Uniform CRUD + uniform shortcuts.** Create/duplicate/archive/delete behave identically across object types; duplication is the primary path for "new study like the last one."

---

## 3. Core Features

### 3.1 Project & study creation
- Create Project → create Studies inside it; study templates by methodology (survey, crowdsourcing, lab experiment, diary study, interview) pre-populate milestones, document checklists, and default instruments.
- Duplicate an entire Study (design + documents + timeline, minus participants/data) for follow-ups and replications.

### 3.2 Experimental design (simplified)
- Structured editor for: research questions, hypotheses, independent/dependent variables, conditions, design type (between/within/mixed), target N, exclusion criteria — structured fields + rich text, rendered into a shareable one-pager that feeds the IRB draft.
- Condition assignment engine: random or manually-defined counterbalanced order assignment of Enrollments to Conditions, with audit trail.
- *Cut from scope:* built-in Latin-square generator and power-analysis helper — record the counterbalancing scheme as a field; use G*Power and paste the result.

### 3.3 IRB & oversight pathway
- **Every Study declares an oversight pathway at creation (changeable by PI):**
  - **IRB-reviewed** (default) — full workflow below; "Start recruiting" is blocked until an approved consent Document exists.
  - **IRB-exempt** — for studies your IRB has formally exempted; requires entering the exemption reference/determination, stored on the Study.
  - **Internal Pilot** — informal piloting with lab members/friends; no IRB workflow. Selecting it requires **PI confirmation plus a short justification**, both recorded in the audit log. The study carries a permanent, prominent **"PILOT — not IRB reviewed"** badge on every view, its Datasets are flagged `pilot` and excluded from publishable exports by default, recruitment is limited to manually-added participants (no public screener pages), and compensation defaults to none. A **"Promote to full study"** action duplicates the design into a fresh IRB-reviewed Study — pilot data never carries over.
  - The tool records the declared status; it doesn't adjudicate it — whether a given pilot truly needs no review is your institution's call, which is why the pathway choice is PI-gated and logged.
- For IRB-reviewed studies:
  - Document templates with merge fields pulled from the Study object (title, procedure, duration, compensation, risks, data handling) so the protocol stays consistent with the actual design.
  - Version history + diffing; amendment workflow (new version linked to change rationale).
  - Review status per Document (draft → internal review → submitted → approved/revisions) with reviewer comments.
  - Approval metadata: protocol number, approval/expiry dates → drives automatic expiry warnings and the recruiting guard.

### 3.4 Participant recruitment
- **Lab-wide participant pool**: demographics, contact channels, participation history, "do not contact" flag, source. Records persist beyond individual studies for re-recruitment, subject to consent terms and retention policy.
- Public **screener pages** (simple-form Instrument) with eligibility rules that auto-set Enrollment status. Protected by Cloudflare Turnstile (free) + rate limiting.
- Recruitment funnel stats per channel (viewed → screened → eligible → consented → completed).
- Quotas per condition/stratum shown on the funnel dashboard; *auto-pause cut* — researchers pause recruiting manually when the dashboard shows a stratum is full.
- Cross-study deduplication warnings; re-recruitment via pool filtering + bulk invites through preferred ContactChannel.

### 3.5 Centralized data repository
- Datasets per Study: file uploads (audio, video, logs → S3), tabular data (built-in form responses or CSV/JSON import with column mapping), generated **codebook**.
- Automatic linkage of every record to pseudonymous participant ID + condition + session. PII lives only on Participant/ContactChannel; "break-glass" re-identification is PI-only and logged.
- A **generic CSV mapper** covers Qualtrics/Prolific exports; *tool-specific importers cut.*

### 3.6 Exploratory data analysis & export (trimmed)
- In-browser EDA on tabular Datasets: summary statistics, histograms/box plots, group-by-Condition comparison, and scale auto-scoring from instrument rules. Computation runs client-side in Fresh islands; inferential work happens locally in R/Python.
- *Cut:* cross-tabs, missing-data report (visible in summary stats anyway).
- Export: CSV, JSON, and **analysis-ready bundles** (data + codebook + auto-generated R/Python loader script). Export profiles: "full" (PI only), "de-identified", "public/OSF-ready".

### 3.7 Study timeline & milestones
- Per-Study milestone list + Gantt-style timeline view; Project-level roll-up calendar.
- Milestone templates per methodology; dependencies and blocking ("can't start recruiting before IRB approval").

### 3.8 Reminders & notifications
- **`Deno.cron` inside the always-on app process** + a `jobs`/`messages` table for idempotency, delivery status, and retries. No external queue/scheduler service.
- Covers: session reminders (email + Telegram), diary ESM prompts (fixed/interval/randomized windows), task due nudges (Discord/email), IRB expiry warnings, compensation-pending alerts.
- Templates with merge fields ({{first_name}}, {{session_time}}, {{study_title}}); every send is a logged Message object.

### 3.9 Compensation management
- Compensation object per Enrollment: amount (SGD default), scheme (flat/per-session/raffle), method, status (pending → approved → paid), payer, paid date, reference.
- **PayNow:** mobile number captured at consent/booking, stored encrypted; payments made manually by a lab member from an exportable **PayNow run sheet**; mark-as-paid with reference.
- **PayPal:** PayPal email stored encrypted; manual payout via run sheet.
- **Prolific:** paid on Prolific; store Prolific ID + submission ID; status updated manually.
- **Reimbursement ledger export**: columns **Name, Phone Number, Compensation Amount** (+ optional date/reference). PII-bearing → PI/approved roles only, audit-logged.
- Outstanding-payments dashboard so no participant goes unpaid.

### 3.10 Authentication & roles
- Lab members: email + password (Argon2id); session cookies (HttpOnly, Secure, SameSite); PI-invites-members, no self-signup. (OAuth cut — one more integration, little gain for a small lab.)
- Roles: **PI** (everything incl. re-identification, deletion, payment approval), **Researcher** (full access to assigned Projects), **Assistant** (operate sessions/recruitment; no raw PII export), **Collaborator** (read-only).
- Participants: no accounts; signed, expiring **magic links** (HMAC tokens) for all participant pages.

---

## 4. Additional Features (kept vs. cut)

**Kept — these are the compliance/operations core:**
1. **Consent with e-signature** + consent-to-recontact flag + re-consent on amendments.
2. **Session scheduling** with participant self-booking, no-show/reschedule tracking, ICS feeds.
3. **Audit log** (PII views/exports, consent changes, deletions, payment approvals).
4. **Instrument library** (simple forms + external-instrument records, versioned, with scoring rules).
5. **Pilot at two levels** — (a) *Internal Pilot studies* (oversight pathway, §3.3): whole studies run without IRB; and (b) *pilot enrollments* inside an IRB-reviewed study (dry-runs of the real protocol): flagged Enrollments/Sessions whose data is segregated and excluded from Datasets/quotas by default. Both share the same `pilot` data flag so nothing pilot ever leaks into publishable exports.
6. **Withdrawal & data-deletion workflow**.
7. **Data retention policies** with PI-approved purge.
8. **Basic study health dashboard** (funnel vs. target N, upcoming sessions, overdue tasks).

**Cut / deferred to backlog (see §8.6):** pre-registration generator (write it in OSF directly; store the link/DOI on the Study), protocol checklists (use a Document), qualitative memos, data-quality flags (straight-lining detection etc.), Qualtrics/Prolific-specific importers, PayPal Payouts API, room/equipment booking (a Session free-text "location/equipment" field suffices).

---

## 5. Integrations

### 5.1 Telegram (participant-facing, primary chat channel)
- Bot API webhook to an app route. Free, no business verification, no message fees.
- Pairing via deep link (`t.me/<bot>?start=<one-time-token>`) from the consent/booking page → chat ID stored as verified ContactChannel.
- Used for: session reminders/confirmations, diary ESM prompts (button with magic link), reschedule notices, payment confirmations. Optional diary quick-replies (opt-in per study). `/stop` deactivates the channel; email becomes fallback.

### 5.2 WhatsApp (optional later adapter)
- No free API for this use case: the Cloud API bills business-initiated "utility" template messages per delivery; only replies within a 24-hour window after the participant messages first are free. Requires Meta Business verification, a dedicated number, and template approval.
- Plan: messaging layer is channel-agnostic (`ChannelAdapter`: email | telegram | whatsapp). Ship Telegram + email; add WhatsApp in the backlog phase if reach demands (budget ~cents per reminder).

### 5.3 Email
- **Amazon SES (ap-southeast-1)**: effectively the cheapest option (~US$0.10 per 1,000 emails) and keeps email handling in-region. Bounce/complaint webhook via a single SNS topic.
- Simpler-setup alternative if SES production-access approval is a hassle: Resend free tier (non-AWS; email bodies transit their infra — keep PII in emails to a first name + link).

### 5.4 Discord (internal only, notifications only)
- Outbound **webhook posts** to lab channels: new eligible participant, session booked/cancelled/no-show, milestone due, IRB expiring, payment pending, job failures. Webhooks need no bot hosting or gateway connection — just an HTTP POST.
- *Cut:* slash commands and the full bot (everything they offered is on the dashboard). No PII in Discord, ever — pseudonymous IDs only.

### 5.5 Notion (internal only, one-way push)
- "Push to Notion" action on a Study: writes/updates a row in a lab Notion database (status, phase, milestone summary, link back to StudyHub) for lab-wiki visibility. Notion pages can be *linked* as Documents (URL records).
- *Cut:* two-way sync and IRB-draft round-tripping — conflict handling isn't worth it; comment on drafts inside StudyHub. No PII to Notion.

---

## 6. Architecture — Minimal AWS (4 services)

**Footprint: one compute instance + S3 + SES + Route 53. Everything else is software on the box.** (Turnstile on public forms is just a free JavaScript widget from Cloudflare — it doesn't require using Cloudflare for anything else; swap for hCaptcha if you prefer.)

| Need | v0.3 (before) | v0.4 (now) | Monthly cost (approx.) |
|---|---|---|---|
| Compute | ECS Fargate + ALB + ACM + Route 53 | **One Lightsail (or EC2) instance**, Docker Compose, **Caddy** for free auto-TLS | US$10–20 (2–4 GB RAM) |
| Database | RDS PostgreSQL | **Postgres container on the same box**, nightly `pg_dump` to S3 | $0 |
| Files & backups | S3 + KMS | **S3** (SSE-S3 default encryption, versioning, lifecycle rules) | ~US$1–5 |
| Email | SES | **SES** | pennies |
| Secrets | Secrets Manager | `.env` file on the instance (root-only perms) | $0 |
| DNS | Route 53 | **Route 53** (kept — everything stays under AWS; hosted zone + A record to the instance; Caddy still does TLS so no ACM/ALB needed) | ~US$0.50/zone |
| Edge protection | WAF, CloudFront | Caddy rate limiting + Turnstile on public pages | $0 |
| IaC | Terraform/CDK | A documented setup script + the compose file | $0 |

**Total: roughly US$15–25/month.**

**The one trade-off that matters:** self-hosting Postgres means *you* own backups. This is non-negotiable for research data, so it's built in as a Phase 0 deliverable, not an afterthought: nightly `pg_dump` to versioned S3, weekly instance snapshot, and a **quarterly restore drill** on the staging compose file. If you'd rather pay ~US$15/month to never think about this, RDS `t4g.micro` (single-AZ) is the one managed upgrade worth its price — everything else in the table stays the same.

### 6.1 The box
- Ubuntu LTS on Lightsail/EC2 `ap-southeast-1`, static IP, ports 80/443 only (SSH via keys, ideally restricted to campus IP range or Tailscale).
- `docker-compose.yml`: **caddy** (TLS, reverse proxy, rate limits) → **app** (Fresh 2 / Deno server, `Deno.cron` inside) → **postgres** (volume-mounted). Deploy = GitHub Actions builds the image, SSHes in, `docker compose pull && up -d`.
- TLS terminates on the instance in Singapore; Route 53 only resolves names, so no traffic is processed outside SG. Residency question fully closed, all under one AWS account.

### 6.2 Data
- Postgres 16 container; Drizzle ORM + migrations; PII columns (name, email, phone/PayNow, Telegram chat ID, PayPal email, signatures) app-layer encrypted (AES-256-GCM, key in `.env`); full-text search via `tsvector`.
- S3 bucket (private, presigned URLs) for uploads, dataset files, and `pg_dump` archives; lifecycle rules implement retention policy.

### 6.3 Application structure
```
routes/
  projects/[id]/...   studies/[id]/...   participants/[id]/...   instruments/[id]/...
  p/[token]/...       # public participant pages (screener, consent, booking, diary)
  api/...             hooks/telegram.ts   hooks/ses-bounces.ts
islands/    # TimelineGantt, EdaCharts, ScheduleBoard, ObjectActionBar
lib/        # db/, objects/, integrations/{telegram,discord,notion,email,s3}, jobs/, crypto/
Dockerfile  docker-compose.yml  Caddyfile  scripts/{setup,backup,restore}.sh
```
- Drizzle + Zod schemas shared server/islands; Argon2id; CSRF tokens; HMAC magic links; audit middleware on PII reads/exports.
- Testing: `deno test` for domain logic/handlers; seeded fake data; staging = the same compose file on a second cheap instance (or the same box, different ports).

---

## 7. Non-Functional Requirements

- **Data residency:** compute, TLS termination, database, files, email region — all in ap-southeast-1; DNS via Route 53 (resolution only). Data-flow diagram documented for IRB.
- **Privacy/compliance:** PDPA-aligned, PII minimization, pseudonymized datasets, audit log, retention policies, role-gated exports, withdrawal/erasure workflow.
- **Backups (promoted to requirement):** nightly `pg_dump` → versioned S3; weekly snapshot; quarterly restore drill; backup-failure alert to Discord.
- **Accessibility:** WCAG 2.1 AA on participant-facing pages.
- **Performance:** pagination at 50; EDA client-side up to ~100k rows.
- **Reliability:** Docker restart policies + healthcheck; idempotent reminder jobs; uptime monitor (free tier, e.g., UptimeRobot) pinging /health.

---

## 8. Development Plan — Phases & Sub-phases (v0.4)

### Phase 0 — Foundations
- **0.1 Scaffold & box:** Fresh 2 app + Dockerfile + compose + Caddyfile; provision Lightsail; Route 53 hosted zone + records; setup script; GitHub Actions deploy; "hello world" on HTTPS in ap-southeast-1.
- **0.2 Data layer + backups:** Postgres container, Drizzle migrations, seed scripts (fake data); S3 bucket + presigned-URL helper; **nightly pg_dump job + restore script + drill doc**.
- **0.3 Auth & members:** login, sessions, PI invites, role middleware.
- **0.4 OOUI shell:** layout, object navigation, the three reusable view patterns, design tokens.
- **0.5 Audit log + crypto:** append-only audit table + middleware; AES-GCM field encryption; magic-link signing.

### Phase 1 — Studies & Documents
- **1.1 Projects & Studies CRUD:** lifecycle states + stepper, duplication, archiving, membership.
- **1.2 Design editor (simplified):** structured fields + one-pager render; condition list; random/manual assignment with audit trail.
- **1.3 Documents & versioning:** version history + diff, review statuses, comments.
- **1.4 Oversight pathway + IRB workflow:** pathway selector (IRB-reviewed / IRB-exempt / Internal Pilot) with PI gate, justification capture, pilot badge, and data-quarantine flag; "Promote to full study" action; merge-field templates, approval metadata, recruiting guard for IRB-reviewed studies.
- **1.5 Milestones & timeline:** CRUD + dependencies, methodology templates, Gantt island, roll-up calendar.

### Phase 2 — Participants & Recruitment
- **2.1 Participant pool:** Participant + ContactChannel (encrypted), demographics, history, dedup warnings.
- **2.2 Simple forms:** form builder for screeners/diary entries (item types, no branching); external-instrument records (Qualtrics links).
- **2.3 Public screeners:** `p/[token]` pages, Turnstile + rate limits, eligibility rules → Enrollment status, funnel stats.
- **2.4 Consent flow:** consent page from approved Document version, e-signature, recontact flag, re-consent on amendment.
- **2.5 Quota dashboard:** per-stratum counts vs. targets (manual pause).
- **2.6 Re-recruitment:** pool filtering + bulk invitations.

### Phase 3 — Sessions, Reminders & Comms  ← *first usable release at the end of this phase*
- **3.1 Scheduling:** slot publishing, self-booking via magic link, reschedule/no-show tracking, ICS feeds.
- **3.2 Messaging core:** Message object, `ChannelAdapter` interface, templates, **SES adapter**, delivery log + bounce hook.
- **3.3 Job infrastructure:** `Deno.cron` + jobs/messages tables, idempotency, retries, failure alerts to Discord webhook.
- **3.4 Telegram adapter:** webhook, pairing deep link, reminders/confirmations, `/stop`.
- **3.5 Diary engine:** ESM schedule builder, prompt dispatch, diary entry pages, optional quick replies.
- **3.6 Discord webhooks (internal):** event notifications per project channel.

### Phase 4 — Data & Compensation
- **4.1 Datasets & uploads:** S3 uploads, pseudonymous linkage, pilot segregation.
- **4.2 Responses & CSV mapper:** form responses as Dataset records; generic CSV/JSON import with column mapping; codebook generation.
- **4.3 EDA (trimmed):** summary stats, histograms/box plots, group-by-condition, scale auto-scoring.
- **4.4 Export:** CSV/JSON, de-identified + OSF-ready profiles, analysis-ready bundle; export audit.
- **4.5 Compensation:** Compensation object, PayNow/PayPal run sheets, Prolific ID tracking, **ledger export (Name/Phone/Amount)** PI-gated + audited, outstanding-payments dashboard, payment confirmations.
- **4.6 Withdrawal & retention:** withdrawal action, retention timers + PI-approved purge.

### Phase 5 — Polish
- **5.1 Notion one-way push** + Notion-page links as Documents.
- **5.2 Basic health dashboard:** funnel vs. N, upcoming sessions, overdue tasks.
- **5.3 Hardening:** accessibility pass, restore drill #1, security review of PII flows.

### 8.6 Backlog (build only when a study demands it)
WhatsApp Cloud API adapter · Latin-square generator & power-analysis helper · quota auto-pause · two-way Notion sync · Discord slash commands · pre-registration generator · protocol checklists · qualitative memos · data-quality flags · Qualtrics/Prolific-specific importers · PayPal Payouts API · room/equipment booking · Google OAuth · i18n.

---

## 9. Decision Log

| Question | Decision |
|---|---|
| Hosting | One Lightsail/EC2 instance in ap-southeast-1 (Docker Compose: Caddy + app + Postgres); DNS via Route 53. ~US$15–25/mo total. |
| AWS services used | **Lightsail/EC2, S3, SES, Route 53 — nothing else.** Optional upgrade: RDS t4g.micro if managed backups are preferred. |
| Pilot studies | Study-level oversight pathway: IRB-reviewed (default) / IRB-exempt (with reference) / Internal Pilot (PI-gated + justification, audit-logged, badged, data quarantined, no public recruitment; "Promote to full study" duplicates without data) |
| Database | Self-hosted Postgres with mandatory nightly pg_dump→S3 + quarterly restore drills (or RDS as the one paid upgrade). |
| Tenancy | Single lab |
| Participant access | Magic links only; persistent Participant records for re-recruitment |
| Surveys | Main surveys stay in Qualtrics/Google Forms; StudyHub builds simple forms only (screeners, consent, diary) and ingests CSV |
| Compensation | PayNow (manual + run sheet), PayPal (manual), Prolific (external) |
| Ledger format | Name, Phone Number, Compensation Amount (PII-restricted, audited) |
| Participant channels | Email (SES) + Telegram; WhatsApp in backlog (per-message fees, Meta verification) |
| Internal channels | Discord webhooks (notifications only) + Notion one-way push; no PII ever |
