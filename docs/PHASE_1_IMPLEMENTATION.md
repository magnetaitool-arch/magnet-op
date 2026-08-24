# Phase 1 implementation status

Date: 2026-08-16  
Branch: `codex/saas-readiness-foundation`  
Scope: non-destructive authentication reliability and SaaS foundation work.

## Outcome

Phase 1 is implemented and verified **locally only**. It has not been applied to the production database, Edge Function, or Vercel deployment. Production is still running accounts Edge Function v11; the reviewed local candidate is v13.

## Implemented in the branch

- The browser loads the Auth rollout contract before login and private data sync.
- Mandatory Auth mode fails closed when a Supabase JWT is absent.
- The rollout contract comes from the accounts Edge Function, not an anonymously readable configuration row.
- A successful login also returns the authoritative rollout contract, eliminating the health/login race.
- Edge Function environment flags provide a safety belt for mandatory Auth cutover.
- Supabase Auth user reconciliation paginates beyond the first 200 identities.
- Authentication success/failure events are pseudonymized and written best-effort to `auth_events` after the foundation migration exists.
- A dedicated `ACCOUNTS_SESSION_SECRET` can decouple legacy session rotation from the service-role key.
- `accounts_safe` has a narrow forward hardening migration.
- The additive organization, profile, membership, role, invitation, audit, job, outbox, and legacy-link foundation has a separate forward migration.
- Read-only production exposure and identity-reconciliation tools were added without printing record payloads, credentials, or direct PII.

## Verification evidence

- Smoke/static application tests: **69 passed, 0 failed**.
- Email/security tests: **24 passed, 0 failed**.
- SaaS foundation safety tests: **46 passed, 0 failed**.
- Python security verifier: **26 passed, 0 failed, 1 documented CSP warning**.
- Edge Function TypeScript syntax bundle: **passed** with esbuild.
- `git diff --check`: **passed**.
- Live configuration gate: **2 failures, 2 warnings**, as expected before the database cutover:
  - `accounts_safe` is anonymously readable.
  - Sample private collections (`clients`, `employees`, `invoices`) are anonymously readable.
  - No local service-role key is available for a complete server-only backup.
  - No local Resend key is available for provider-level email verification.

Browser visual QA was not completed in this phase because the existing `file://` tab could not be reloaded through the controlled browser security policy. The inline application scripts were parsed successfully, but this does not replace staging browser/E2E tests.

## Production facts at handoff

- Production URL: `https://magnet-op.vercel.app`.
- Expected Supabase project: `jdylrthffifbhyrrhuqd`.
- Production accounts health reports **v11**, `needsSetup=false`, and no server Auth rollout contract.
- The connected Supabase account exposes only unrelated projects, so no production migration, function deployment, secret change, or data write was attempted.
- No complete current service-role backup or tested staging restore exists.

## Safe execution order

1. Connect Codex/Supabase to the account that owns `jdylrthffifbhyrrhuqd`.
2. Inspect live schema, grants, policies, migrations, Auth settings, Edge secrets/version, advisors, usage, and storage read-only.
3. Create a complete encrypted backup including `_accounts`; restore it to staging and validate counts/checksums.
4. Apply the two new migrations to staging only and rerun database/RLS safety tests.
5. Deploy accounts v13 to staging with `ACCOUNTS_SESSION_SECRET`; keep `AUTH_V2_ENABLED=false` and `AUTH_V2_REQUIRED=false` initially.
6. Deploy the compatible frontend to a preview environment and test login, refresh, logout, reset, invite, disabled user, role change, and every live role.
7. Run the identity reconciliation tool with staging service-role access and repair duplicates/missing links through reviewed migrations or product workflows.
8. Pilot Supabase Auth for an owner/test cohort with `enabled=true`, `required=false`; observe failures and data-path mismatches.
9. Backfill organization ownership, implement tenant/capability RLS, and prove cross-tenant denial.
10. Set `AUTH_V2_REQUIRED=true` only in the same controlled release that removes anonymous private access. Roll out one role at a time with rollback ready.

## Stop conditions

Do not deploy or apply the restrictive migrations if the correct project is not connected, the complete backup cannot be restored, identity reconciliation has unresolved conflicts, any role cannot complete the staging smoke, or the old application still performs anonymous private reads/writes.
