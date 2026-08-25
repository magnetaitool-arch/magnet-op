# M1 Identity — Staging checkpoint (2026-08-25)

This checkpoint records implementation and live validation on **MAGNET OS STAGING** only. Production application code, Production database schema, and the Production Vercel deployment were not changed.

## Implemented

- Reconciled the local migration directory with the exact remote migration lineage. The previous `001`–`008` and `APPLY_ALL.sql` files are preserved byte-for-byte under `supabase/legacy-migrations/` and are not active migrations.
- Upgraded the existing Auth profile table in place and added organizations, organization memberships, tenant roles, capabilities, invitations, audit events, outbox/jobs, idempotency, and legacy cutover mappings.
- Added a live JWT identity context. Protected identity calls resolve the current profile, active organization, membership, role, and capabilities on every request.
- Added locked schema foundations for WhatsApp MFA challenges, trusted devices, and authentication rate limits. Raw OTPs and device fingerprints are not stored.
- Added transactional role/status administration with last-owner protection, session revision, immutable audit history, and a confirmed legacy compatibility bridge.
- Added idempotent first-login reconciliation. A verified legacy login creates/links the Supabase identity and membership once; an existing canonical membership is never overwritten by a stale legacy role.
- Updated the browser login path to require the canonical identity before loading private data. The live membership role wins over cached `_accounts` role values.
- Updated Users & Permissions so confirmed accounts load their canonical membership and role changes use the canonical server command. Hard deletion is disabled for canonical identities; deactivation preserves history.
- Deployed the `identity` and updated `accounts` Edge Functions to Staging only.

## Staging data integrity

After all tests and disposable-canary cleanup:

- Legacy business records: **1,780**
- Supabase Auth users: **14**
- Canonical profiles: **14**
- Organization memberships: **14**
- Confirmed legacy identity links: **14**
- Organizations: **1**
- Remaining disposable login canaries: **0**
- Remaining disposable Auth canaries: **0**

The read-only reconciliation diagnostic still reports five legacy accounts that have not yet created a Supabase Auth identity and seventeen employee records without an account link. The five accounts now reconcile automatically on their next verified login. Employee records without login accounts require an explicit Owner decision; they are not data loss and are not auto-linked by email guessing.

## Verification

- Offline smoke: **82 passed, 0 failed**
- Email security: **24 passed, 0 failed**
- SaaS foundation: **48 passed, 0 failed**
- Identity structural gate: **61 passed, 0 failed**
- Static security verifier: **26 passed, 0 failed, 1 documented CSP warning**
- Staging identity E2E: **15 passed, 0 failed**
- Staging full login/cutover: **16 passed, 0 failed**
- Migration preflight: every new migration executed against the restored Staging schema inside a forced rollback before it was applied.
- Current local and Staging migration histories match through `20260825163000`.

The full login test covers creation of a disposable legacy account, password verification, Supabase JWT upgrade, automatic canonical linking, role precedence, stale legacy-role resistance, canonical Content → Sales repair, access-override clearing, live-session refresh, and complete cleanup.

## Not yet complete

- WhatsApp provider integration and OTP send/verify UI are not enabled. Only the safe database foundation exists.
- Five existing accounts have not completed their first canonical login yet.
- Employee/account reconciliation still needs an Owner-facing review workflow for genuinely missing or ambiguous links.
- Business records are still in the legacy `records` table. Tenant mapping, scoped server APIs, and restrictive business-data RLS are M2/M3 work and must be validated on Staging before activation.
- Production remains blocked by Supabase HTTP 402 and missing future-deployment email environment variables. Nothing in this checkpoint authorizes a Production migration or deployment.

## Rollback

- Vercel: retain the previous Staging Preview and re-point only the Staging alias if the new Preview fails.
- Edge Functions: redeploy the prior Staging function artifact from the recovery commit.
- Database: migrations are additive. Disable the V2 identity path and ship a reviewed forward migration; do not edit or delete applied migrations or identity data.

## Gate

M1 canonical identity is ready for Staging UI validation. M2/M3 business-data hardening must not be enabled until the V2 browser is proven to send its Supabase JWT for every scoped query and mutation.
