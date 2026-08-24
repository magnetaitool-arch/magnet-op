# Magnet OS SaaS readiness audit

Audit date: 2026-08-16  
Branch: `codex/saas-readiness-foundation`  
Production URL: `https://magnet-op.vercel.app`  
Supabase project reference found in the application: `jdylrthffifbhyrrhuqd`

## Executive outcome

Magnet OS is a feature-rich internal agency PWA, but it is **not safe to sell as a multi-tenant SaaS today**. Its largest risk is architectural: authenticated-looking screens do not imply authenticated database access. The browser normally uses the public Supabase key, downloads the shared business dataset, and applies role filters in JavaScript.

A read-only production probe on 2026-08-16 confirmed that the public key could read:

| Collection/view | Publicly visible rows | Sensitive field names confirmed without printing values |
|---|---:|---|
| `employees` | 26 | `salary`, `bankAccount`, `bankName`, `nationalId`, address, email, phone, role |
| `invoices` | 20 | `amount`, `tax` |
| `clients` | 20 | client contact phone and role |
| `leads` | 66 | email and phone |
| `tasks` | 242 | business workflow records |
| `reports` | 21 | client reporting records |
| `accounts_safe` view | at least 1 | email, username, phone, role, default-password flag |
| `_accounts` | 0 | correctly hidden by current base-table RLS |

No production row was modified during this audit. A complete live schema/advisor/migration inspection could not be performed because the available Supabase connector returned `permission denied` for every project operation. Therefore production-only claims are explicitly marked **not verified**. A restrictive migration must not be applied until a service-role backup and staging restore are available; the current app would otherwise stop loading data.

## Scope and evidence

Reviewed:

- Static frontend and all data/auth paths in `index.html` (about 11,000 lines and 1.2 MB).
- `supabase/functions/accounts/index.ts` (custom account service and optional Auth bridge).
- `api/intake.js`, `api/send-email.js`, Netlify twins, `vercel.json`, service worker, manifests, environment templates.
- Migrations `001` through `008`, combined `APPLY_ALL.sql`, root schema/RLS SQL, and the old Auth migration blueprint.
- Backup/restore/config/security scripts and all current automated tests.
- Git state, tracked secret patterns, deployment linkage, and local backup inventory.
- Read-only public PostgREST behavior in production. No mutation probes were performed.

Baseline verification:

- Smoke: 69 pass, 0 fail.
- Email/security test: 24 pass, 0 fail.
- SaaS foundation safety: 46 pass, 0 fail.
- Static security verifier: 26 pass, 0 fail, 1 CSP warning.
- Edge Function TypeScript syntax bundle: pass.
- Live config: endpoint reachable; local service-role and Resend secrets unavailable.

Implementation progress and the exact staging/production gates are recorded in `docs/PHASE_1_IMPLEMENTATION.md`.

These tests validate selected legacy behavior. They do **not** validate tenant isolation, Supabase JWT use, authenticated RLS, transactional workflows, real email delivery, or the complete auth lifecycle. Green legacy tests must not be interpreted as SaaS readiness.

## Current architecture

### Frontend

- Static React 18 + HTM application shipped from one `index.html`, without a production build, bundler, TypeScript, lint step, or route modules.
- LocalStorage is a working cache and offline surface, not just a transient view cache.
- `cloudLoadAll` downloads all allowed rows and groups them by JSONB `coll`.
- `cloudUpsert`/`cloudDelete` write directly from the browser to PostgREST.
- Failed writes enter a browser queue; merge behavior is client-timestamp last-write-wins.
- Role/navigation/data-scope decisions are implemented in `VIEW`, `EDIT`, `ROLE_ALIAS`, `PERMISSIONS`, and many page-specific conditions.

### Authentication

- Primary login uses a custom Supabase Edge Function against JSONB `_accounts` rows.
- Passwords are PBKDF2 hashes stored inside `records.data`.
- The function issues a custom HMAC token valid for 30 days. It is not a Supabase JWT and cannot establish the `authenticated` Postgres role.
- An optional `AUTH_V2` bridge can synchronize the password to Supabase Auth and return a real session, but the production flag record was not publicly visible and login deliberately succeeds if this bridge fails.
- The browser therefore normally operates with only the public key after a visually successful login.

### Database

- One generic `public.records` table: text ID, collection name, JSONB payload, timestamps, and soft-delete metadata.
- More than 50 unrelated domains share this table: CRM, employees, attendance, payroll, finance, content, approvals, files, reports, and auth metadata.
- No organization/agency foreign key exists on business rows.
- Base-table `_accounts` is blocked from anonymous access, but other collections remain anonymously readable/writable by design.
- A sanitized `accounts_safe` view is publicly readable because views can bypass base-table RLS and the migration did not use `security_invoker` or revoke grants.

### Backend and integrations

- Accounts Edge Function uses the service-role key for account operations.
- Vercel functions send email through Resend and accept public intake.
- Background automation is largely browser-session driven; there is no durable scheduler/queue worker.
- There is no central server API for business CRUD, transaction boundaries, idempotency, or capability enforcement.

### Deployment and operations

- Vercel project is linked locally as `magnet-op`.
- No GitHub Actions workflow exists.
- No central application error monitoring, auth metrics, durable job monitor, or alerting configuration is present.
- Local JSON backups exist, but a current complete service-role backup could not be created in this environment.

## P0 — Critical

### P0-01 — Anonymous exposure and mutation of private business data

- **Current implementation:** Migration `002` gives `anon` select/insert/update/delete for every `records` row except `_accounts` and `_ratelimit`. The publishable key is intentionally embedded in `index.html`.
- **Why this is a problem:** Anyone can bypass the login UI and access private HR, finance, client, lead, task, and report data. Because writes are also allowed, data corruption or deletion is possible without a Magnet account.
- **Affected files:** `index.html`, `supabase/migrations/002_records_rls_hardening.sql`, `supabase-auth-migration.sql`, `supabase-schema.sql`.
- **Affected tables:** `public.records` and every business collection within it.
- **Severity:** P0 / release blocker.
- **Recommended fix:** Make Supabase Auth JWTs mandatory for private data; introduce organizations/memberships; attach every business row to an organization; enforce tenant and capability policies in RLS; move public forms behind server endpoints.
- **Migration implications:** High risk. Additive schema and backfill first, verify JWT adoption, then restrict anonymous policies. Never flip RLS directly on current production.
- **Tests required:** Anonymous read/write denial; Agency A cannot read/update/delete Agency B; role capability matrix; service endpoint intake tests; rollback smoke.

### P0-02 — No tenant identity in the data model

- **Current implementation:** The application represents one Magnet agency. Business rows have no `organization_id`; some records infer relationships through JSON client/project IDs.
- **Why this is a problem:** Correct tenant filtering is impossible, user-to-agency assumptions are implicit, and future customer data would share the same namespace.
- **Affected files:** `index.html`, all schema and migration files.
- **Affected tables:** `public.records`; future organizations, profiles, memberships, roles, clients.
- **Severity:** P0 before external agency onboarding.
- **Recommended fix:** Normalize `organizations`, `profiles`, `organization_members`, roles/capabilities, and organization ownership. A user may have multiple memberships.
- **Migration implications:** Add nullable ownership, create the current Magnet organization, deterministic backfill, validate zero unowned private rows, then enforce `NOT NULL`/FK/RLS.
- **Tests required:** Multi-membership selection; missing membership recovery; suspended organization; orphan query; cross-tenant access.

### P0-03 — Authentication success can exist without authenticated database access

- **Current implementation:** Custom Edge login returns an HMAC token. `doLogin` treats the optional Supabase Auth session as best effort; `_headers` falls back to the public key.
- **Why this is a problem:** A legitimate user sees a role-bearing session while Postgres sees `anon`. Database authorization cannot trust the UI identity, and role changes/session state can diverge.
- **Affected files:** `index.html` auth/sync functions; `supabase/functions/accounts/index.ts`.
- **Affected tables:** `_accounts` JSONB rows, `auth.users` when bridge is used, all private records.
- **Severity:** P0.
- **Recommended fix:** One canonical Supabase Auth identity, mandatory session before private data load, explicit profile/membership resolution, a recovery screen for incomplete states, and server-side auth context.
- **Migration implications:** Reconcile legacy accounts to Auth identities by normalized email with manual review for ambiguity. Do not silently create/reset Auth passwords on every login.
- **Tests required:** login → session → profile → membership → active organization; expired refresh; role update; disabled user; no redirect loop; legacy migration cohort.

### P0-04 — Role/permission enforcement is client-side and inconsistent

- **Current implementation:** Role aliases and permissions are scattered through frontend constants and page conditions. The Edge Function only recognizes Owner/Admin/Manager as account administrators. `Account Manager` aliases to a different base profile in UI logic.
- **Why this is a problem:** UI hiding can be bypassed. Stale sessions and duplicated role strings caused real employees to enter with the wrong role or miss CRM data.
- **Affected files:** `index.html` role tables, menu filters, CRUD paths; accounts Edge Function.
- **Affected tables:** legacy `_accounts`, `employees`, and every protected domain.
- **Severity:** P0.
- **Recommended fix:** Stable role IDs plus capabilities; organization membership is the source of role; server context authorizes every command; UI consumes the same capability result.
- **Migration implications:** Map legacy role strings to reviewed canonical roles. Ambiguous aliases require an admin decision, not an automatic guess.
- **Tests required:** one fixture per role/capability; stale-role session refresh; privilege escalation attempts; direct API tests.

### P0-05 — Partial and duplicated identity state

- **Current implementation:** Identity, role, employee profile, and optional Auth user are separate, weakly linked JSON records. Person-specific migrations `005`–`008` repaired duplicate or missing links after the fact.
- **Why this is a problem:** Invalid states are structurally allowed. Duplicate accounts previously made login nondeterministic; a profile can exist without the right account; role changes can update only one side.
- **Affected files:** migrations `005`–`008`, auth and employee-edit code in `index.html`, accounts Edge Function.
- **Affected tables:** `_accounts`, `employees`, `auth.users`.
- **Severity:** P0.
- **Recommended fix:** Explicit profile FK to `auth.users`, unique active organization membership, normalized email constraints, transactional membership/role changes, and an idempotent reconciliation tool.
- **Migration implications:** Report anomalies first, archive source rows, repair deterministic links, require manual decisions for conflicts. Never auto-delete identities.
- **Tests required:** duplicate email/case; missing profile/membership; repeat invite/signup; role edit immediately reflected; historical fixture reconciliation.

### P0-06 — Sensitive roster view bypasses intended protection

- **Current implementation:** `accounts_safe` removes password/token fields but is a normal view over `_accounts`; it is publicly queryable in production.
- **Why this is a problem:** Email, username, phone, role, and password-status metadata leak even though the base account rows are protected.
- **Affected files:** `supabase/migrations/003_accounts_security.sql`.
- **Affected tables/views:** `public.accounts_safe`, `public.records`.
- **Severity:** P0 privacy leak; the narrow fix is low-risk.
- **Recommended fix:** Set `security_invoker=true` on supported Postgres, revoke all from `anon`/`authenticated`, grant only an intentional admin/service path, or remove the unused view.
- **Migration implications:** Add a new forward migration; do not edit `003`. Verify nothing in production depends on direct view access.
- **Tests required:** anon/authenticated denial; authorized admin diagnostic returns sanitized fields only.

### P0-07 — Production schema and backup state are not independently verifiable

- **Current implementation:** Local migrations exist, `APPLY_ALL.sql` only includes `001`–`004`, live Supabase connector access is denied, and the latest complete service-role export is unavailable locally.
- **Why this is a problem:** Applying changes without knowing production drift or having a tested restore can cause outage/data loss. Historical backups may exclude `_accounts`.
- **Affected files:** migrations, `APPLY_ALL.sql`, backup tools, local environment.
- **Affected tables:** all production data.
- **Severity:** P0 operational blocker for schema changes.
- **Recommended fix:** Restore admin access, export full schema/data, capture applied migration list/advisors, restore to staging, document RPO/RTO, and automate encrypted backups.
- **Migration implications:** No production migration until the gate passes.
- **Tests required:** checksum/count validation; staging restore; point-in-time/backup recovery drill; live rollback rehearsal.

## P1 — Required before SaaS launch

### P1-01 — Generic JSONB record store lacks relational integrity

- **Current implementation:** Text IDs and JSON keys represent relationships. Required fields, foreign keys, scoped uniqueness, status checks, and delete behavior are mostly absent.
- **Why:** Orphans, invalid states, naming drift, and role/profile mismatches recur.
- **Files/tables:** `index.html`, `public.records`, all schema files.
- **Fix/migration:** Normalize core identity, tenancy, client, workflow, finance, and HR entities incrementally. Add FKs/constraints after validated backfills; retain a compatibility adapter during transition.
- **Tests:** constraint violations; orphan scans; backfill parity; compatibility reads.

### P1-02 — Multi-record workflows are not transactional

- **Current implementation:** Approvals, report generation, notifications, account/profile edits, and related state changes issue independent browser writes.
- **Why:** A network failure can leave half-completed workflows.
- **Files/tables:** generic CRUD and workflow handlers in `index.html`; many collections.
- **Fix/migration:** Server commands/RPC transactions with idempotency keys, state transition checks, and an outbox for notifications.
- **Tests:** fault injection after each step; retry idempotency; concurrent approval/update.

### P1-03 — Last-write-wins sync can overwrite or resurrect data

- **Current implementation:** Client clocks and timestamps resolve conflicts; failed writes retry from browser cache.
- **Why:** Stale tabs can overwrite newer rows; clock skew and tombstones can produce inconsistent state.
- **Files/tables:** `mergeDB`, `mergeColl`, `cloudUpsert`, queue code; `records`.
- **Fix/migration:** Server-generated revision/version, compare-and-set mutations, durable command IDs, explicit conflict UI, no browser bulk roster upload.
- **Tests:** two-tab concurrent edit/delete; offline rejoin; clock skew; duplicate retry.

### P1-04 — Password recovery is not a proper token lifecycle

- **Current implementation:** `forgot` emails a new temporary plaintext password, then rotates the stored hash only when the provider accepts the request. Delivery is not guaranteed; old sessions remain valid.
- **Why:** Users can be locked out by delayed/bounced mail; credentials travel by email; sessions are not revoked.
- **Files/tables:** accounts Edge Function, email endpoint, `_accounts`.
- **Fix/migration:** Supabase Auth reset link/PKCE flow, single-use expiry, safe resend, session revocation rules, delivery events.
- **Tests:** request/delivery/callback/new password/old session; expired/reused link; bounce; enumeration safety.

### P1-05 — Auth bridge performs unsafe operational reconciliation at login

- **Current implementation:** Auth v2 enumerates at most 200 Auth users and creates or resets the Auth password to the submitted legacy password during login.
- **Why:** It does not scale, couples migration to every login, obscures partial failures, and can overwrite Auth credentials.
- **Files/tables:** accounts Edge Function; `auth.users` and `_accounts`.
- **Fix/migration:** One-time auditable identity migration/reconciliation, explicit linkage table, provider-native password reset for exceptions.
- **Tests:** over-200 users; duplicate email; provider failure; already-linked user; replay.

### P1-06 — Rate limiting is non-atomic and stored in the generic table

- **Current implementation:** Read-count-then-upsert in `_ratelimit` can lose concurrent increments; failure paths fail open.
- **Why:** Brute-force protection is bypassable under concurrency and can also create confusing lockouts.
- **Files/tables:** accounts Edge Function; `_ratelimit` rows.
- **Fix/migration:** Atomic database RPC or managed rate limiter keyed by normalized identifier plus IP/device risk; structured events and admin unlock.
- **Tests:** concurrent attempts; rolling windows; legitimate unlock; provider outage.

### P1-07 — No durable background jobs/outbox

- **Current implementation:** Automatic reports, reminders, and some email triggers run when a browser session is open.
- **Why:** Tasks are missed when nobody is online and retries are not guaranteed.
- **Files/tables:** automation/report/email code in `index.html`; notifications/reports.
- **Fix/migration:** Durable scheduler, jobs table/queue, outbox, attempt state, backoff, dead-letter diagnostics.
- **Tests:** worker crash/retry; duplicate delivery; delayed job; idempotent report generation.

### P1-08 — Email delivery is not operationally reliable

- **Current implementation:** Resend acceptance is treated as success; no authoritative webhook ledger, suppression list, or guaranteed retry exists.
- **Why:** Payroll/task emails may not arrive and admins cannot distinguish accepted, delivered, bounced, or complained.
- **Files/tables:** email functions and UI diagnostics.
- **Fix/migration:** Domain verification, signed webhooks, message/outbox status, idempotency key, retries, suppression, in-app notification fallback.
- **Tests:** delivered/bounced/complained/provider timeout/webhook replay.

### P1-09 — No subscription/entitlement or platform administration boundary

- **Current implementation:** `plans` is a business collection, not an enforced SaaS entitlement system; no platform-admin isolation exists.
- **Why:** Commercial access, limits, trials, suspension, billing events, and support impersonation cannot be safely enforced.
- **Files/tables:** current plans/settings UI and records.
- **Fix/migration:** Organizations, subscriptions, entitlements, usage, billing webhook events, platform admins separated from tenant admins, audited support access.
- **Tests:** plan limit enforcement; failed payment/suspension; tenant admin cannot become platform admin; webhook replay.

### P1-10 — Incomplete observability, CI, and release gates

- **Current implementation:** No CI workflow, central error monitoring, auth metrics, database policy tests, or automated deployment smoke.
- **Why:** Regressions and production failures remain invisible until employees report them.
- **Files/tables:** repository and deployment configuration.
- **Fix/migration:** CI for tests/static checks/migration lint; Sentry-equivalent; structured auth/audit/job events; uptime and synthetic auth monitoring.
- **Tests:** intentionally failing build/migration; alert delivery; staging synthetic flow.

### P1-11 — Existing migrations contain person-specific credentials and destructive fixes

- **Current implementation:** `005`–`008` hardcode employee IDs/emails; `008` commits a PBKDF2 temporary-password verifier; `005`/`006` delete duplicate rows after archiving.
- **Why:** Migration history contains personal data and credential material, cannot generalize, and creates long-term audit/security exposure.
- **Files/tables:** migrations `005`–`008`, `_accounts`, backup table.
- **Fix/migration:** Do not rewrite applied history; immediately rotate affected credential; remove one-off secrets from future distribution where history policy permits; replace with parameterized admin reconciliation commands and audit events.
- **Tests:** secret scanning; reconciliation dry-run; exact-target archive/repair; no broad delete.

## P2 — Important

### P2-01 — Monolithic uncompiled frontend

- **Problem:** A 1.2 MB inline app with `unsafe-inline` CSP is fragile, slow to review, and lacks type guarantees.
- **Fix:** Incrementally extract a compiled TypeScript app, beginning with auth context, API client, permissions, and shared domain schemas. Keep compatibility and route-level rollout flags.
- **Tests:** build/typecheck/lint; route parity; CSP without inline code; bundle budgets.

### P2-02 — Incomplete Arabic, RTL, accessibility, and mobile regression coverage

- **Problem:** Translation and visual behavior are manually tested; document `lang`/`dir`, semantic labels, keyboard flow, and RTL parity are inconsistent.
- **Fix:** Central i18n, semantic tokens, accessible components, automated RTL/mobile screenshots and axe checks.
- **Tests:** 375px/desktop; Arabic/English; light/dark; keyboard/screen reader.

### P2-03 — Agency domain features duplicate loosely-related data

- **Problem:** Client overview, contacts, assets, reports, requests, meetings, approvals, and workflow records are separate JSON objects without a canonical Client HQ aggregate or enforced ownership.
- **Fix:** Normalize Client HQ, stakeholder responsibilities, internal client team, Magnet Flow templates/instances, state machines, and activity timeline.
- **Tests:** one source of truth across sections; workflow transition rules; archive/restore.

### P2-04 — Search, reporting, and performance are not tenant-indexed

- **Problem:** Full-dataset downloads and JSONB scans grow linearly; pagination and tenant-aware indexes are missing.
- **Fix:** Server pagination/search, organization-scoped composite/partial indexes, reporting projections/materialized views where justified, avoid N+1.
- **Tests:** explain plans; load tests at target tenant/data sizes; query budgets.

### P2-05 — Storage and file authorization model is incomplete

- **Problem:** Many “files” are external links; no consistently enforced tenant folder/key ownership, retention, malware scanning, or signed URL policy exists.
- **Fix:** Private object storage buckets with organization/client paths, RLS, signed URLs, metadata and audit events.
- **Tests:** cross-tenant object denial; expired URL; deleted client retention/export.

## P3 — Later

### P3-01 — Advanced SaaS customization

White-label domains, themes, logos, email branding, locale/timezone defaults, custom roles, and feature flags after the security foundation is proven.

### P3-02 — Advanced agency intelligence

Client health scoring, forecasting, capacity planning, churn risk, anomaly detection, and recommendations only after canonical data and trustworthy KPIs exist.

### P3-03 — Ecosystem integrations

Provider OAuth integrations for ad platforms, calendars, storage, accounting, and communications using encrypted tenant-scoped credentials and revocation.

## Database root causes

1. The generic JSONB table accepted states the database could not understand or reject.
2. Identity and role were duplicated across account, employee, session, and optional Auth records.
3. The public database key doubled as the application data-access mechanism.
4. Authorization happened after data download, not before data release.
5. Browser-driven multi-write workflows lacked transaction boundaries and idempotency.
6. Client timestamps were treated as authoritative versions.
7. Person-specific repair migrations fixed symptoms but did not establish a canonical lifecycle.
8. Live schema drift and backups were not mandatory release gates.

## Existing schema before modification

Core known live-compatible objects:

- `public.records(id text primary key, coll text not null, data jsonb not null, updated_at timestamptz, created_at, created_by, updated_by, deleted_at)`.
- `public.migration_audit` and `public.records_backup_001` from early migrations.
- Partial unique expression indexes for normalized account email and username from migration `006`.
- RLS allowing anonymous access to all non-account/non-rate-limit collections.
- `public.accounts_safe` view, publicly visible in the production probe.
- Optional `auth.users` identities created by the bridge; count/link status not verified.

Production constraints, policies, advisors, functions, grants, and applied migration list remain **not verified** until Supabase project access is restored.

## Proposed staged schema

Foundation entities:

- `organizations`
- `profiles` linked one-to-one to `auth.users`
- `organization_members` with explicit status and role
- `roles`, `capabilities`, `role_capabilities`
- `organization_invitations` with hashed token, expiry, intended email/role, acceptance/revocation state
- `auth_events` and append-only `audit_events`
- `idempotency_keys` / command receipts
- `jobs` and `outbox_messages`

Business entities migrate by domain and carry an enforced `organization_id`: clients, stakeholders, client team, projects/workflows, tasks, deliverables/content, approvals, requests, meetings, decisions, reports, files, finance, and HR. Sensitive HR/finance details are separated from general profiles and protected by capabilities.

## Data migration and rollback plan

1. Obtain a service-role export and schema dump; validate checksum and row/collection counts.
2. Restore to isolated staging and run anomaly diagnostics without repairs.
3. Create the initial Magnet organization with a generated UUID and stable slug; never hardcode the ID.
4. Reconcile `auth.users` ↔ legacy `_accounts` ↔ employees. Produce manual-review rows for ambiguity.
5. Add foundation tables and nullable ownership mappings. Do not change current reads yet.
6. Backfill ownership deterministically and compare counts/checksums per collection.
7. Add constraints as `NOT VALID` where appropriate, validate separately, then enforce.
8. Deploy dual-read/dual-write compatibility behind a feature flag and observe mismatch metrics.
9. Require Supabase JWT, switch server operations, test every role and cross-tenant denial.
10. Restrict anonymous access only after zero legacy private reads/writes are observed.

Rollback is forward and non-destructive: disable feature flags, return application reads to the compatibility adapter, and restore previous policies if and only if the previous app is active. New tables remain for investigation. A data restore is reserved for proven corruption and must use the validated backup. Do not delete migrated source rows during the stabilization window.

Overall migration risk: **High**, reducible through additive phases, staging restore, metrics, and reversible flags.

## Implementation roadmap and gates

1. Audit and architecture documentation — this document set.
2. Immediate exposure diagnostics and safe view hardening migration.
3. Additive tenancy/auth foundation schema.
4. Identity reconciliation and canonical RBAC.
5. Data ownership backfill and integrity constraints.
6. Server-side business command layer and transactional workflows.
7. Mandatory JWT data path and RLS rollout.
8. Client HQ and stakeholder/client-team model.
9. Magnet Flow and agency workflow state machines.
10. Content, approvals, requests, meetings, decisions, reports.
11. SaaS super admin and organization lifecycle.
12. Plans, entitlements, usage, billing readiness.
13. Notifications, audit, jobs, monitoring, backups.
14. Modular frontend, CI, E2E/security/performance/RTL tests.
15. Staging pilot, recovery drill, production rollout, two-week internal stabilization.

Every phase requires relevant tests, honest build/lint/typecheck status, migration verification, security checks, and a rollback note. Restrictive production changes additionally require a current backup and staging smoke.

## Readiness score with evidence

| Area | Score / 100 | Evidence |
|---|---:|---|
| Database reliability | 28 | Backups/tools and some unique indexes exist; relational constraints/transactions/verified live schema do not. |
| Security | 18 | Password hashes are hidden, but private business/HR/finance data is publicly readable and writable. |
| Multi-tenancy | 5 | No organization ownership or tenant RLS exists. |
| SaaS architecture | 12 | Internal modules are broad; subscriptions, entitlements, org lifecycle, platform admin are absent. |
| Agency operations | 67 | CRM, HR, tasks, approvals, reports, finance, and content features are substantial but weakly modeled. |
| UX | 61 | Rich bilingual PWA, but role inconsistency, auth recovery, accessibility, and automated RTL coverage remain. |
| Performance | 32 | Full-table sync and monolithic bundle do not scale; some indexes and delta sync exist. |
| Observability | 15 | Basic diagnostics exist; no central metrics, alerts, tracing, or durable job/email lifecycle. |
| Backup/recovery | 35 | Local exports and restore tools exist; current complete backup and recovery drill are missing. |
| **Overall SaaS readiness** | **23** | Suitable only for a controlled internal stabilization after urgent data isolation work; not for external tenant sale. |

## Immediate release decision

- **Do not onboard another agency.**
- **Do not apply a blanket RLS lockdown yet** because the live browser would lose data access.
- First obtain Supabase admin access and a complete backup.
- Apply and verify the narrow `accounts_safe` view hardening.
- Build the additive auth/organization foundation, reconcile identities in staging, then move private data to mandatory JWT + tenant RLS.
