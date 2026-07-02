# Magnet OS

Internal operating system for a marketing/creative agency — CRM, HR, finance,
projects, tasks, public intake, training docs. Single-file React PWA (`index.html`,
React + `htm`, **no build step**) with a Supabase backend and Vercel serverless
functions. Premium dark UI with a lime accent.

- **Live:** https://magnet-op.vercel.app · default login `owner` / `admin123` (rotate immediately)
- **Deploy target:** Vercel · **Supabase project:** `jdylrthffifbhyrrhuqd`

## First-time setup

```bash
cp .env.example .env          # fill in keys (see .env.example)
# (optional) run the QA + config checks — needs Node 18+
npm run smoke                 # offline syntax + dangerous-pattern scan
npm run check:config          # live: Supabase, RLS, accounts fn, email
```

The app itself needs no install/build — it's static. `package.json` exists only for
the backup/QA tooling.

## Environment variables
See **[.env.example](.env.example)**. Secrets (never in the browser):
`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, and the intake `SUPABASE_KEY`.

## Backup before deployment (always)
```bash
npm run backup:supabase       # -> backups/magnet-os-backup-<ts>.json (checksummed)
npm run backup:validate backups/<file>.json
```
Full guide: **[BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)**.

## Migration steps (Supabase)
Deploy the accounts Edge Function first, then apply migrations in order:
```
supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd
# then, in Supabase SQL Editor:
supabase/migrations/001_backup_and_audit.sql
supabase/migrations/002_records_rls_hardening.sql
supabase/migrations/003_accounts_security.sql
supabase/migrations/004_activity_and_sync_metadata.sql
```
Details + verification: **[SUPABASE_SECURITY_GUIDE.md](SUPABASE_SECURITY_GUIDE.md)**.

## Rollback
- DB: each migration has non-destructive ROLLBACK notes; `002` can restore the old
  open policy. In-DB restore point: `records_backup_001`.
- Data: `tools/restore-supabase-records.js` (dry-run default, never deletes).
- Code: `git revert` the relevant commit (baseline tag `ef51ad7`).

## Documentation map
| Doc | Purpose |
|---|---|
| [AUDIT_REPORT.md](AUDIT_REPORT.md) | Phase 0 — full architecture audit + risk ranking |
| [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) | Backup/restore/validate tooling |
| [SUPABASE_SECURITY_GUIDE.md](SUPABASE_SECURITY_GUIDE.md) | RLS model, migrations, verification |
| [AUTH_SECURITY_REPORT.md](AUTH_SECURITY_REPORT.md) | Auth old/new flow + test checklist |
| [SYNC_ENGINE_REPORT.md](SYNC_ENGINE_REPORT.md) | Sync lifecycle, conflict rules, offline |
| [DEPLOYMENT_FIXED.md](DEPLOYMENT_FIXED.md) | Current Vercel deployment runbook |
| [DATA_MODEL.md](DATA_MODEL.md) | Collections, sensitive fields, public-form safety |
| [DATA_MIGRATION_PLAN.md](DATA_MIGRATION_PLAN.md) | Path to normalized tables (later) |
| [REFACTOR_REPORT.md](REFACTOR_REPORT.md) | Monolith refactor strategy |
| [QA_CHECKLIST.md](QA_CHECKLIST.md) | Manual + automated QA |
| [FINAL_ENGINEERING_REPORT.md](FINAL_ENGINEERING_REPORT.md) | What changed, commands, checklist, risks |
| DEPLOYMENT.md (legacy) | Old Netlify runbook — superseded by DEPLOYMENT_FIXED.md |

## Known limitations
- Business collections (clients/finance/HR) are still readable with the public anon
  key by design — only `_accounts` (password hashes) is locked down. Full per-collection
  isolation requires **Stage B** (Supabase Auth); see the security guide + migration plan.
- The UI still lives in one large `index.html` (a working, section-marked monolith).
- Sync is non-destructive last-write-wins; a **durable pending-write queue + visible
  conflict-review UI** is designed but not yet wired (see SYNC_ENGINE_REPORT.md).

## Recommended next refactor phase
1. Apply migrations `001–004` + deploy the accounts function; verify with `check:config`.
2. Add the durable sync queue (isolated module — SYNC_ENGINE_REPORT.md).
3. Extract helpers → services from `index.html` (REFACTOR_REPORT.md).
4. Begin Stage B (Supabase Auth) using DATA_MIGRATION_PLAN.md, on a branch.
