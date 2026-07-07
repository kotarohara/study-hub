# Security review — PII flows & magic links (Phase 5.4)

Scope: verify every PII read/export path is role-gated and audited, and
pen-test the magic-link capability tokens (expiry, purpose confusion,
tampering). Reviewed against spec §4 (privacy invariants), §3.10 (roles),
§7 (compliance).

## Roles

`PI > Researcher > Assistant > Collaborator` (`lib/auth/roles.ts`,
`hasRole` is a rank comparison). Collaborators have *limited access* —
notably, no participant PII.

## Magic-link tokens

All participant-facing capabilities are purpose-scoped HMAC-SHA256 tokens
(`lib/crypto/magic_link.ts`): `signToken`/`verifyToken`, signature checked
with `timingSafeEqual` **before** payload parsing so error reasons leak
nothing. Purposes in use: `booking`, `calendar`, `consent`, `diary`,
`telegram_pair`.

Pen tests (`lib/crypto/magic_link_pentest_test.ts`) attack the full
purpose matrix:

- **Purpose confusion** — a token minted for any purpose verifies for that
  purpose *only*; every cross-purpose verification returns null. (A consent
  link can never be replayed as a booking link, etc.)
- **Tampering** — re-encoding the payload to change the subject or upgrade
  the purpose (keeping the original signature) fails; truncated, bit-flipped,
  and missing signatures fail; a token minted with a different secret fails.
- **Expiry** — a token past its TTL is rejected (verified against a
  still-valid control).

Public participant routes are additionally rate-limited (`RateLimiter`) and,
where public (screener), protected by Turnstile. Booking/diary/consent
tokens are the capability, so no account is required — which is why the
purpose/expiry/tamper guarantees above are load-bearing.

## PII read/export paths

| Path | Gate | Audit |
|---|---|---|
| Participant pool list (`/participants`) | assistant+ | `pii.list_viewed` |
| Participant detail (`/participants/[id]`) | assistant+ | `pii.view` |
| Participant edit / new / channels / dnc | assistant+ | `pii.view` / channel actions |
| Dataset file download (`/datasets/[id]/files/…`) | study-visible | `dataset.file_downloaded` |
| Dataset export — `full` profile | **PI** | `export.create` |
| Dataset export — de-identified / OSF | researcher+ | `export.create` |
| Payment run sheet (name + pay address) | **PI** | `pii.export` |
| Reimbursement ledger (Name/Phone/Amount) | **PI** | `pii.export` |
| Participant purge (erasure) | **PI** | `participant.purged` |
| Break-glass re-identification | PI (existing, audited) | — |

### Finding fixed in this review

`/participants` (pool list) and `/participants/[id]` (detail) rendered
decrypted names and channel values but were gated only by "signed in" — a
**collaborator could view participant PII**. Both now require `assistant+`
(matching the edit/new/channel routes), consistent with §3.10's
limited-collaborator model. The audit writes were already present; only the
gate was missing.

## Invariants re-confirmed

- **PII isolation**: PII lives only on `participants` / `contact_channels`,
  app-layer encrypted (`encryptedText`). Datasets, messages-log views,
  Discord, and Notion carry pseudonymous codes only — enforced by the
  de-identified/OSF export profiles and the Discord/Notion no-PII tests
  (payload types have no PII field by construction).
- **Audit log**: append-only (DB triggers); `details` never contains PII
  (pseudonymous `code` only), asserted across the object test suites.
- **Pilot quarantine**: `is_pilot` inherited at insert time; excluded from
  listings/stats/exports by default.
- **Data residency / at-rest**: unchanged by this phase.

## Residual notes (not blocking, tracked)

- Notion/Discord/SES tokens live in env config; production secret handling
  is a Phase 6 (deployment) concern.
- The de-identified export uses `Math.random` for id shuffling by default;
  fine for de-identification (not a security boundary), and tests inject a
  deterministic RNG.
