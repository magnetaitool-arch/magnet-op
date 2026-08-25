# M0 FINAL REPORT

Date: 2026-08-25

Scope: Supabase safety gate, recoverable staging copy, backup, restore validation, security baseline, and Vercel environment separation only.

Production project: `jdylrthffifbhyrrhuqd`

Staging project: `xqqgbvigfojfydzfguan` (`MAGNET OS STAGING`)

No M1 identity/RLS/Auth migrations were run. No WhatsApp OTP work, destructive Production database command, Production deployment, or Production promotion was performed.

## 1. Supabase access status

- Supabase CLI authentication is working on this Mac.
- Read/admin access to the intended Production project was verified.
- The Management API reports the project as `ACTIVE_HEALTHY` in `eu-west-1`.
- The application-facing Production services are nevertheless restricted for quota overage and return HTTP 402. The dashboard identifies egress quota as the restriction reason.
- This distinction is critical: the control plane is healthy enough for inventory/backup work, but the Production application is not operationally healthy.

## 2. Production inventory

### Database and schema

- PostgreSQL engine: 17.6; platform build observed as 17.6.1.127; timezone UTC.
- Public relations inventoried: 26 tables plus views.
- Public database functions: 20.
- Public triggers: 13.
- RLS policies: 43 across the inventoried schemas.
- Installed extensions: `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, and `uuid-ossp`.
- Production storage: 0 buckets and 0 objects.
- Edge Functions:
  - `accounts`: active, version 11, JWT verification disabled at the gateway.
  - `lead-intake`: active, version 2, JWT verification disabled at the gateway.

### Auth

- Users: 14.
- Identities: 14.
- Sessions at snapshot: 9.
- MFA factors: 0.
- Email confirmation is enabled; new signup is enabled; anonymous sign-in is disabled.
- Production Auth Site URL is incorrectly set to `http://localhost:3000` and no redirect URLs are registered. This was inventoried but not changed in M0.

### Snapshot data

- `records`: 1,780 rows across 45 collections.
- `_accounts`: 19.
- Clients: 20.
- Employees: 26.
- Applicants/candidates: 73.
- Tasks: 242.
- Contracts: 1.
- Invoices: 20.
- Payments: 14.
- Employee payments: 18.
- Expenses: 1.

Production continued changing after the snapshot. The last read-only comparison observed 1,884 Production `records` versus the 1,780-row snapshot, including newer activity logs, candidates, and notifications. A fresh backup is therefore mandatory immediately before any later Production cutover.

## 3. Full backup status

- Backup directory: `/Users/mac/Documents/MagnetOS/backups/m0-full-20260824-kRqcmq`
- The directory is outside Git, gitignored, and permissioned `0700`; backup files are `0600`.
- Included:
  - complete public schema inventory;
  - all public business rows, including `_accounts`;
  - safe Auth inventory without password hashes, OTPs, refresh tokens, or recovery/session secrets;
  - policies, grants, functions, triggers, extensions, and migration state;
  - storage bucket/object inventory;
  - downloaded live Edge Function source inventories;
  - restore SQL, manifest, validation report, and security baseline.
- SHA-256 checksums were generated and all listed files passed verification.
- The backup contains sensitive legacy account records and must remain local and access-restricted.

## 4. Staging project status

- A separate Supabase organization and a separate project named `MAGNET OS STAGING` were created.
- Staging has independent Database, Auth, Storage, API keys, Edge Functions, and environment values.
- Staging does not connect to the Production database.
- Staging is `ACTIVE_HEALTHY` in `eu-west-1`, PostgreSQL 17.6, UTC.
- Production email/Resend secrets were not copied into Staging.
- Staging Auth Site URL and exact redirect allow-list entry point to the dedicated stable Vercel Staging URL.

## 5. Restore status

- Restored 26 public tables, 1,780 `records`, 45 collections, and the nine captured remote migration records.
- Restored policies, functions, triggers, extensions, grants, views, and schema definitions for baseline fidelity.
- Deployed separate Staging copies of `accounts` and `lead-intake`, matching Production names and gateway JWT settings.
- Created 14 disabled, synthetic-email Auth placeholders in Staging to preserve profile foreign keys without copying Production credentials, identities, or sessions.
- Staging Auth after restore: 14 placeholders, 0 identities, 0 sessions.
- Storage restore was empty because Production had 0 buckets and 0 objects.

## 6. Production vs Staging validation

Snapshot-to-Staging validation passed:

- all public table row counts match the backup;
- all 45 collection counts match;
- clients, employees, accounts, candidates, tasks, finance, contracts, invoices, and payments match the snapshot;
- policies, functions, triggers, extensions, and remote migration state are semantically equal;
- storage inventory matches at 0 buckets / 0 objects;
- Edge Function names and gateway JWT flags match.

Difference report: `/Users/mac/Documents/MagnetOS/backups/m0-full-20260824-kRqcmq/staging-difference-report.json`

The restored Staging database matches the point-in-time snapshot, not post-snapshot Production writes.

## 7. Applied migration matrix

The Production and Staging remote migration histories match each other exactly:

| Remote version | Name | Production | Staging | Local filename match |
|---|---|---:|---:|---:|
| 20260701074208 | lockdown_accounts_from_anon | Applied | Applied | No |
| 20260701074434 | harden_leftover_functions | Applied | Applied | No |
| 20260701074525 | revoke_public_execute_leftover_fns | Applied | Applied | No |
| 20260701130827 | enable_realtime_records | Applied | Applied | No |
| 20260710220934 | magnet_records_indexes | Applied | Applied | No |
| 20260710222635 | magnet_auth_functions_policies | Applied | Applied | No |
| 20260710222759 | magnet_create_auth_accounts | Applied | Applied | No |
| 20260712100915 | magnet_os_001_to_004_backup_audit_rls_softdelete | Applied | Applied | No |
| 20260730093602 | align_roles_and_lock_salary_changes | Applied | Applied | No |

Local `001` through `008` files are not registered under their local versions in remote history. The two `20260816...` SaaS/RLS migrations are local-only and were not applied. `APPLY_ALL.sql` was not run. Migration lineage must be reconciled before M1; applied migrations must not be edited or blindly replayed.

## 8. Vercel environment separation

- Stable Staging alias: `https://magnet-os-staging.vercel.app`
- Current underlying Preview deployment: `https://magnet-di18nzect-magnetaitool-archs-projects.vercel.app`
- Preview/Development runtime configuration points only to the new Staging Supabase project.
- A server endpoint now supplies only the public deployment-scoped Supabase URL and publishable key to the browser; no service-role key is exposed.
- Hosted runtime configuration overrides stale browser cache, preventing Preview from silently reconnecting to Production.
- The final Preview rendered successfully, reached the restored `accounts` Edge Function, detected the existing account roster, and displayed the normal sign-in screen with no observed error overlay.
- Production was not deployed or promoted; `https://magnet-op.vercel.app` still points to its previous deployment.
- A read-only health request confirms the current Production deployment still has working email configuration and returned HTTP 200. No email was sent.

### Vercel environment incident and containment

While removing Preview/Development scopes from Vercel email variables, the Vercel CLI removed shared environment-variable records rather than only the requested scopes. As a result, future Production deployments currently have no saved Production email environment definitions. The already-running Production deployment retains its immutable environment snapshot and is unaffected until redeployment.

The helper was corrected to fail closed: it now refuses to touch any Supabase variable shared with Production, performs email-scope checks read-only, and never removes environment-variable records.

Do not redeploy Production until the Production email variables have been recreated/rotated and verified.

## 9. Security baseline on Staging

The following current-state issues were reproduced on Staging before any M1 fix:

- anonymous reads from `accounts_safe` are possible;
- anonymous reads of private business collections are possible;
- public intake writes are possible;
- anonymous updates of private records are possible;
- anonymous deletes of private records are possible.

All mutation probes were wrapped in transactions and rolled back.

A controlled Staging-only canary verified:

- legacy login succeeds;
- the Auth v2 session path succeeds;
- unauthorized admin listing is rejected;
- live server role refresh overrides a stale token role;
- canary account/Auth cleanup completed, returning Staging to 14 placeholders, 0 identities, and 0 sessions.

Baseline report: `/Users/mac/Documents/MagnetOS/backups/m0-full-20260824-kRqcmq/staging-security-baseline.json`

## 10. Remaining M0 blockers

1. Production Supabase application services remain quota-restricted and return HTTP 402. Management access alone does not make the SaaS usable.
2. Vercel Production email environment definitions must be recreated/rotated before any new Production deployment. The current deployment is still configured, but a redeploy would not be safe.
3. Production Auth Site URL and redirect allow-list are incorrect. M0 was read-only for Production, so they remain unchanged.
4. Local and remote migration histories do not share a clean one-to-one lineage. This must be reconciled before applying M1 migrations.
5. Production changed after the M0 snapshot; a new pre-cutover backup and count validation will be required later.

Actions requiring the owner personally or explicit M1/Production authorization:

- resolve the Supabase quota restriction through the Supabase Billing/Usage UI (wait for the quota cycle to reset or choose an approved paid capacity path);
- create a replacement Production Resend API key in Resend without pasting it into chat;
- coordinate a new shared email secret across Vercel Production and the Production Supabase Edge Function secret store, followed by a controlled deployment and email health/delivery test;
- correct Production Auth URL configuration during the authorized cutover window.

## 11. Exact M1 readiness status

Staging, backup, restore tooling, snapshot validation, and the pre-fix security baseline are ready for M1 engineering work. The overall safety gate is not green because Production is HTTP 402-restricted, future Production email environment definitions are missing, and migration lineage is unresolved.

Tests completed after the final tooling changes:

- smoke/static suite: 75 passed, 0 failed;
- email security suite: 24 passed, 0 failed;
- SaaS foundation static suite: 47 passed, 0 failed;
- Python security verifier: 26 passed, 0 failed, 1 documented CSP warning;
- backup checksum verification: all files passed.

The SaaS exposure audit against restricted Production is invalid as a security pass because every application request returned HTTP 402. The equivalent Staging baseline was used instead.

## Final status

`M0 BLOCKED — DO NOT START M1`
