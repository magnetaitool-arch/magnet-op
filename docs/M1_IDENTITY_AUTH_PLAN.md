# M1 identity and authentication implementation plan

Status: READY FOR REVIEW — implementation blocked by incomplete M0 gates
Date: 2026-08-24

M1 replaces the split Employees / `_accounts` / Supabase Auth authority with one
canonical identity and authorization context. It is an incremental migration,
not a big-bang rewrite.

## M1 outcome

After M1, a protected request is accepted only when all of these are true:

1. Supabase Auth session is valid.
2. The Auth user has one canonical application profile.
3. The selected organization is active.
4. The user has an active membership in that organization.
5. The membership references a valid organization role.
6. Required capabilities are resolved server-side.
7. Required MFA/step-up assurance is satisfied.
8. The account/session has not been disabled or invalidated.

The employee record is linked by immutable IDs. Names, usernames, email text,
job titles, and cached role strings are not authorization inputs.

## Non-goals

- No recruitment, finance, contract, tasks, or visual redesign in M1.
- No destructive removal of legacy records.
- No immediate global Auth V2 requirement before cohort validation.
- No tenant RLS cutover before the compatible JWT data path passes staging.
- No WhatsApp credential or destination is committed to Git.

## Canonical model

### Supabase Auth

`auth.users.id` is the only authentication identity and session authority.

### Application profile

`profiles.user_id` is a one-to-one foreign key to `auth.users.id` and stores:

- normalized email
- display name
- normalized phone in E.164 form
- phone verification timestamp
- explicit account status
- onboarding state
- session invalidation epoch/version

### Organization membership

`organization_members` stores:

- organization ID
- user ID
- role ID
- explicit membership status
- joined/archived timestamps
- optimistic revision

Capabilities are derived through `role_capabilities`. The browser never submits
an organization, role, or capability that the server trusts.

### Employee link

Create an additive normalized `employees` table in staging with at least:

- `id uuid primary key`
- `organization_id uuid not null`
- `user_id uuid null`
- `employee_number`
- `display_name`
- `work_email_normalized`
- `phone_e164`
- `employment_status`
- `legacy_record_id text unique`
- `revision integer`
- created/updated/archived timestamps

Enforce one linked employee per `(organization_id, user_id)` when `user_id` is
not null. Sensitive HR, identity, bank, and compensation data will remain outside
the broad employee profile and move later to capability-protected child tables.

### Login aliases

Create `login_aliases` for username support:

- alias is normalized and globally unique, because organization selection occurs
  after primary login.
- alias links to one `auth.users.id`.
- status is active/revoked.
- alias creation/change is server-only and audited.

Email login continues through normalized email. Username resolution never returns
the mapped email to an unauthenticated caller.

## Account lifecycle state machine

```text
INVITED
  -> PENDING_VERIFICATION
  -> PENDING_SETUP
  -> ACTIVE
  -> SUSPENDED | DISABLED
  -> ACTIVE (audited reactivation)
  -> ARCHIVED
```

Illegal transitions fail in a transaction. Role change, deactivation,
reactivation, lock, unlock, password reset, membership change, and session
invalidation generate immutable audit/auth events.

## Safe lifecycle commands

### Invite user

1. Admin sends organization, intended role, email, optional employee link, and an
   idempotency key to a server command.
2. Server validates `members.manage` and organization status.
3. Server creates a hashed, expiring, single-use invitation.
4. Provider identity creation/invite is reconciled by normalized email.
5. Outbox entry sends the invite; success is not reported as delivered until the
   provider webhook confirms it.
6. Replay returns the original invitation result.

### Accept invite / first login

1. Hash and lock the invitation token.
2. Validate state, expiry, email binding, organization, and role.
3. Verify or create the Supabase Auth identity.
4. In one transaction create/update profile, membership, employee link, and audit
   event; mark the invite accepted.
5. Require password setup and verification.
6. Resolve canonical context; only then open the application.

### Deactivate/reactivate

- Update profile/membership status server-side.
- Revoke provider sessions or increment the session epoch.
- RLS/context checks deny already-issued tokens immediately based on database
  status.
- Preserve employee and business history.
- Reactivation is explicit and audited.

### Password reset

- Use Supabase Auth recovery/PKCE links.
- Token is provider-generated, expiring, single-use, and redirect allow-listed.
- Never email a temporary plaintext password.
- Define and test whether reset revokes other sessions.
- Provider accepted, delivered, bounced, expired, and reused states are visible.

## Server architecture

Add a new identity surface rather than expanding browser authority:

```text
supabase/functions/identity/
  login
  context
  invite
  accept-invite
  password-recovery
  deactivate/reactivate
  session-invalidate
  mfa/challenge
  mfa/verify
```

Reusable server modules belong under `supabase/functions/_shared/`:

- auth context resolution
- capability checks
- request IDs and safe logging
- idempotency
- atomic rate limiting
- provider adapters
- normalized identifiers

The existing `accounts` function remains a temporary compatibility bridge. Its
legacy token cannot authorize normalized business APIs.

## WhatsApp MFA and step-up authentication

WhatsApp is an additional assurance factor, never the identity authority.

### Required step-up policy

MFA is required for:

- Admin and Super Admin sessions.
- HR and Finance sessions.
- new/untrusted devices.
- suspicious login attempts.
- salary, bank, payroll, permission, export, contract-signing, and other sensitive
  commands even when the base session is already active.

### Provider abstraction

Define a server-only interface:

```text
sendOtp(recipientRef, template, code, correlationId)
getDeliveryStatus(providerMessageId)
verifyWebhook(signature, payload)
```

The initial provider may be Meta WhatsApp Cloud API or another approved provider.
Provider credentials, business destinations, templates, and test numbers are
environment configuration, not repository constants.

### Challenge storage

Create `mfa_challenges` with:

- user/session/purpose/provider
- HMAC or password-hash of the OTP, never plaintext
- short expiry
- maximum attempts
- atomic attempt count
- pending/verified/expired/locked/cancelled state
- provider message reference
- request/correlation ID
- created/verified timestamps

Create `auth_session_assurance` keyed by Supabase Auth session ID. Before OTP,
the session has primary assurance only and RLS/server commands deny protected
business data. After successful OTP, assurance is upgraded for a limited period.

Trusted-device identifiers are random, revocable, hashed server-side, and set via
a first-party Secure/HttpOnly/SameSite cookie. Device trust never bypasses a
sensitive-action step-up policy.

### Abuse controls

- Atomic per-IP, per-identifier, per-user, per-session, and per-destination limits.
- Single active challenge per purpose where appropriate.
- Constant-time verifier comparison.
- Generic unauthenticated responses.
- Lock and cooldown after attempt limits.
- Audit every request, provider failure, verify success/failure, expiry, replay,
  and admin unlock without storing OTPs or message payloads.

## Canonical auth context

Every protected request resolves:

```text
request_id
auth_user_id
profile_status
session_id
session_epoch
assurance_level
active_organization_id
organization_status
membership_id
membership_status
role_id
capabilities[]
employee_id (nullable)
```

Failure states have deterministic screens: unauthenticated, verification needed,
setup incomplete, MFA required, membership missing, disabled account, suspended
organization, organization selection, and session expired. No redirect loop and
no fallback to anonymous private reads are allowed.

## Migration sequence

Every migration is new and append-only.

### M1.1 — Verify foundation on restored staging

- Review the existing foundation migration against the live schema dump.
- Apply it to restored staging only.
- Confirm all new tables are locked from anon/authenticated.
- Confirm legacy row counts/checksums are unchanged.

### M1.2 — Employee, alias, session, MFA, and rate-limit foundation

- Add normalized employees and login aliases.
- Add MFA challenges, assurance sessions, trusted devices, and atomic rate-limit
  tables/functions.
- Add transition constraints, indexes, and append-only auth/audit events.
- Keep all tables locked until policies and server context are ready.

### M1.3 — Dry-run reconciliation

Produce counts only first:

- legacy accounts without Auth identity
- Auth identity without profile
- employee without canonical account link
- duplicate/invalid normalized identifier
- missing or conflicting role
- missing membership
- invalid phone for MFA
- unresolved organization ownership

No automatic deletion or person-specific migration is permitted.

### M1.4 — Backfill canonical organization and identities

- Create the Magnet organization.
- Seed reviewed roles/capabilities.
- Link unambiguous legacy account/Auth/employee records in bounded idempotent
  batches.
- Send conflicts to an explicit admin reconciliation queue.
- Record before, after, orphan, and conflict counts for every batch.

### M1.5 — Dual-run identity service

- Deploy the new identity service to staging.
- Keep legacy auth available behind a feature flag for the test cohort only.
- The compatible frontend obtains a Supabase session and canonical context before
  loading private data.
- Compare legacy and canonical role/account status; mismatch blocks cutover and
  emits a safe event.

### M1.6 — MFA cohort

- Use a staging/test WhatsApp provider/template.
- Test Admin, HR, Finance, new device, suspicious login, and sensitive commands.
- Test provider outage and retry behavior without bypassing assurance.

### M1.7 — Controlled cutover

- Owner/test cohort first, then one role at a time.
- Require canonical Auth for private API access.
- Disable legacy private writes only after cohort tests pass.
- Retain legacy account rows read-only during the observation period.

## Feature flags

- `IDENTITY_V2_ENABLED`
- `IDENTITY_V2_REQUIRED`
- `IDENTITY_V2_COHORTS`
- `MFA_ENABLED`
- `MFA_REQUIRED_ROLES`
- `MFA_SENSITIVE_ACTIONS`

Flags are server-controlled, environment-validated, and included in the canonical
context. The browser cannot loosen them.

## Risks and controls

| Risk | Control |
|---|---|
| Team locked out | cohort rollout, legacy compatibility window, tested admin recovery |
| Duplicate Auth users | normalized reconciliation and manual conflict queue |
| Wrong role after migration | server comparison and fail-closed mismatch state |
| RLS enabled before JWT path | hard deployment dependency and automated gate |
| OTP provider outage | explicit failure state/retry; no MFA bypass |
| Stale session keeps privilege | DB membership/status check and session invalidation epoch |
| Email/reset not delivered | outbox, webhook state, resend action, diagnostics |
| Migration replay | idempotency keys, unique constraints, bounded batches |
| Data loss | additive schema, preserved legacy rows, full backup/restore gate |

## Rollback

Before tenant RLS enforcement:

- disable Identity V2/MFA feature flags for the affected cohort;
- promote the compatible previous frontend and identity artifact;
- preserve new additive tables and events for diagnosis;
- do not delete newly created Auth identities automatically.

After tenant RLS enforcement:

- application, identity function, and policies are one compatibility unit;
- roll back to the prior tested policy/app bundle;
- never re-enable anonymous private data access;
- use a forward corrective migration for data/schema defects.

## Test matrix

### Authentication lifecycle

- valid/invalid email and username login
- case/space normalization
- duplicate/conflicting identifier
- first login and password setup
- email verification and resend
- access/refresh expiry and rotation
- local/global logout
- password recovery, expired/reused link, session revocation policy
- disabled/suspended/reactivated/archived account
- organization selection and suspended organization
- missing profile/membership recovery without redirect loops

### Invitation and reconciliation

- new and existing identity invite
- duplicate idempotent request
- wrong email, expired, revoked, replayed invite
- employee link creation and conflict
- role change takes effect without stale cached permission
- all legacy identities classified; no silent orphan

### MFA

- required-role login
- new/trusted/revoked device
- sensitive-action step-up
- expired, wrong, replayed, and exhausted OTP
- per-identity/IP/destination rate limits
- provider timeout/failure/webhook replay
- assurance expiry and session invalidation

### Authorization

- anonymous denial
- Employee, Team Lead, HR, Finance, Sales, Admin, and Super Admin capability
  matrix
- cross-tenant REST, RPC, storage, search, and server-command denial
- disabled membership and suspended organization denial

### Security and observability

- no password, OTP, verifier, token, invite secret, or full message payload in
  logs
- correlation ID across auth, outbox, provider, and audit events
- atomic rate-limit concurrency test
- secret scan and RLS tests in CI

## Definition of done

M1 is complete only when:

- M0 full backup and staging restore are proven.
- Every live account is linked, intentionally excluded, or in a reviewed conflict
  queue.
- Supabase Auth is the sole session authority for the production cohort.
- Canonical context resolves profile, organization, membership, role,
  capabilities, and employee ID.
- Login, invite, reset, deactivation, role change, session invalidation, and MFA
  pass in staging and controlled production smoke.
- No private data request succeeds with the public key alone.
- Administrators can diagnose and repair supported identity states from the
  product without an AI-written person-specific migration.
