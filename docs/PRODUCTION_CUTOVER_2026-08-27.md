# MAGNET OS V2 Production Cutover — 2026-08-27

## Outcome

MAGNET OS V2 is live at `https://magnet-op.vercel.app` on Vercel deployment
`dpl_HjZWiYpStTBstbPNNvVvm4cMCij3`. The deployment is connected to the healthy
Supabase project `xqqgbvigfojfydzfguan`; the retired HTTP 402 project is not used
by the browser or the Vercel server routes.

The old Supabase project was not modified or deleted and remains an emergency
rollback source. Its final cutover backup is outside Git at:

`backups/cutover-final-20260826-85N7P9`

The V2 target was also backed up before synchronization at:

`backups/pre-cutover-staging-20260827-3RM9v7`

Both backups have validated SHA-256 checksums and restrictive local file
permissions.

## Data cutover

- 1,875 source business/account rows were compared by stable record ID.
- 235 rows were created, 14 changed rows were updated, and 1,626 rows were
  already identical.
- 11 target-only historical test rows were soft-deleted; no target row was
  hard-deleted by the cutover.
- Validation found 0 missing source rows, 0 mismatched source rows, and 0 active
  target-only business rows at cutover completion.
- All 19 legacy account roles matched before the switch. The known Sales account
  resolves to Sales in both the legacy account and canonical membership models.

The machine-readable report is outside Git at:

`backups/cutover-final-20260826-85N7P9/cutover-sync-report.json`

## Release gates

- Local application suite: passed, including 116 smoke checks after the final
  CORS/runtime configuration changes.
- Static security verifier: 25 passed, 0 failed, 1 documented legacy CSP warning.
- Identity: 15/15 passed.
- Full login and live-role cutover: 23/23 passed.
- Restored Auth repair: 5/5 passed.
- Tenant RLS: 31/31 passed.
- Organization settings: 25/25 passed.
- Employee privacy: 20/20 passed.
- Public intake: 10/10 passed.
- Delivery outbox: 18/18 passed.
- Recruitment V2: 20/20 passed.
- Sales and Client Workspace V2: 24/24 passed.
- Finance V2: 22/22 passed.
- Contracts V2: 30/30 passed.
- Documents V2: 38/38 passed.
- Tasks, search, and notifications: 24/24 passed.
- Approvals V2: 18/18 passed.
- System Health V2 database gate: 9/9 passed.
- Deployed public forms: 13/13 passed on Staging and 13/13 passed on the exact
  Production deployment; all synthetic rows were removed.

## Live verification

- `/`: HTTP 200.
- `/api/runtime-config`: HTTP 200 and resolves only the V2 Supabase ref.
- `/serviceworker.js`: HTTP 200 with `no-store`.
- `/manifest.json`: HTTP 200.
- Production accounts health: HTTP 200, database reachable, mandatory Auth V2
  enabled, and the exact Production origin is allowed.
- Browser verification: meaningful login UI rendered, Arabic `lang=ar` and
  `dir=rtl` were correct, no framework overlay appeared, and there were no live
  console errors.
- Vercel showed no error-level or HTTP 5xx runtime logs after cutover checks.

## Auth and rollback

- Supabase Auth Site URL is `https://magnet-op.vercel.app`.
- Staging remains in the redirect allow-list for recovery/testing.
- The retired Supabase project and both cutover backups are preserved.
- Git release commit: `97ca43c` on `codex/magnet-os-v2-staging`.
- A Vercel rollback can re-point the public alias, while database rollback must
  use the validated snapshot and the documented restore procedure.

## Known degraded capability

Core login, data, roles, CRM, HR, tasks, finance, contracts, documents, public
forms, approvals, and notifications are live. External email delivery is not
enabled on the new Vercel deployment because no current Resend credential exists
in the Production environment. Email requests remain durable and visible in the
outbox instead of being silently lost, but task/payslip/report email and legacy
forgot-password email will not reach recipients until a free Resend sender and
Production environment variables are configured.

The healthy Supabase project is now the Production database. Before the next
development release, create a fresh independent Supabase Staging project and
point the Staging Vercel project to it so future QA can never mutate Production.
