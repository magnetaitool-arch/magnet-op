# Hosted staging verification — 2026-09-26

Independent free Supabase project: `vsurqqbxjvqzvqbmetjw` (Magnet OS Release Staging).
PRIVATE Auth (`kwrlqlgsnvequjgdkxbc`) was paused with explicit owner approval to free the account's second free-project slot. No subscription was purchased. Magnet business data remains in `xqqgbvigfojfydzfguan`.

Preview: https://magnet-lxn09czi0-magnetaitool-archs-projects.vercel.app
Vercel deployment: `dpl_8Lba5rMP9ybvz78agQHQxatc8UQm`; existing magnet-op project, preview only. Runtime bindings explicitly target the independent staging project. Its accounts and identity functions are deployed, JWT mode required, CORS includes the preview, and email fallback cannot call production.

## Verified

- Installed the existing schema-only legacy fixture, then 47 canonical migrations through Supabase CLI `db push`, preserving their original versions and SQL. No production rows copied.
- All 18 September 25 migrations applied. Production read-only ledger comparison also found the older `20260902000100_employee_requests_v3` absent: production has **19 pending files**, not 18.
- Per-migration ledger, count, constraint, index and policy snapshots retained privately in `backups/release-staging-20260926`. No existing table count reductions detected. Ordered 18-file risk/object manifest and SHA-256 source manifest are included there. Re-running the runner without `--apply` skips all applied versions successfully.
- Real hosted accounts login, Supabase Auth session, canonical owner/workspace, missing-JWT denial, cross-tenant read/write denial, task-create idempotent retry, refresh and restored identity passed.
- Actual deployed browser: login, dashboard, projects, tasks, CRM lead creation/persistence across reload, approval-center opening, logout and return to login after reload. Arabic RTL at 390×844 has no horizontal document overflow. No page exceptions observed. Screenshots in `audit-assets/2026-09-26`.
- Build, existing scoped lint/typecheck and syntax checks for the two new release tools pass. Existing extensive SQL tests remain useful but are not relabelled as hosted E2E evidence.

## Release gate remains closed

The hosted baseline is synthetic and initially has no historic business records. Successful SQL application/count checks do not establish representative production migration safety or full business E2E. Complete role matrix, revoked sessions, storage object flows, Studio, proposal-to-approval trajectory and sanitized representative reconciliation remain pending.

Production provider recovery inventory returned `pitr_enabled:false`, `backups:[]`, and no physical recovery-point metadata. `walg_enabled:true` alone is not proof of a usable backup. The canonical read-only schema export attempt reached temporary login-role initialization but failed because Docker/Podman is unavailable. No dump or verified restore is claimed. No production migration or application promotion performed; genuine business rows were not altered.

Credentials and synthetic test-account sessions are stored locally under `~/.config/magnet-os/` with restricted permissions, outside Git; never print these files. Synthetic QA rows are retained only in independent staging for subsequent verification. Do not reuse or expose the QA account as a production identity. Resume with the existing staging project; do not create another project or repeat completed migrations.
