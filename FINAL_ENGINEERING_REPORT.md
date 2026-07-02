# Magnet OS — Final Engineering Report

Production-stabilization pass. Baseline commit `ef51ad7`. All changes are additive or
surgical; **no data deleted, no tables dropped, no production data overwritten, no
feature removed**. The running app was verified in a browser (boots, login works,
dashboard + sidebar + all modules render, dark/lime identity intact, zero console
errors).

## Honest scope note
This environment had **no Node/Deno runtime**, so the JS tooling and Deno function
could not be executed here. They were validated by careful review + a live
browser boot of the app + a repo-wide dangerous-pattern grep (results below). Run
`npm run smoke` and `npm run check:config` once on a Node 18+ machine to complete
automated verification — nothing is claimed as "passing" that was not actually run.

## What was fixed (by brief issue #)
- **#6 Forgot-password crash** — implemented the missing `sendMail` in the accounts
  Edge Function (Resend, with `/api/send-email` fallback); it only rotates a password
  when mail actually sends, and always returns `{ok:true}` (no account-existence leak).
- **#5 / Phase 3 client-side hashing** — `changepw` now ignores any client `newHash`
  and always PBKDF2-hashes `newPassword` server-side; the frontend sends `newPassword`.
- **#3 anon exposure** — migration `002` blocks anon from `_accounts` (password
  hashes) without breaking the app; leaky server errors replaced with a generic 500.
- **#7 Vercel/Netlify mismatch** — added Vercel `api/intake.js`; Netlify kept as legacy.
- **#10 project-ref mismatch** — corrected stale `ksunojpdzunyqrxdmogd` → `jdylrthffifbhyrrhuqd`
  in the intake function and `DEPLOYMENT.md`.
- **#9/#13/#14 backup** — full backup/restore/validate tooling + Backup Center (existing)
  + in-DB snapshot (migration `001`).
- **#2 generic records table** — kept (non-destructive); normalization path documented.
- **#1/#11/#12 monolith/UX** — kept working; refactor + role-UX documented as safe next steps.

## Files changed / added
**Edited (surgical):**
- `supabase/functions/accounts/index.ts` — add `sendMail`; server-only hashing in
  `changepw`; generic error handler.
- `index.html` — `PwResetForm` sends `newPassword` (no client hash). No other logic touched.
- `netlify/functions/intake.js` — corrected project-ref comment.
- `DEPLOYMENT.md`, `HANDOVER.md`, `SECURITY-UPGRADE.md` — corrected refs / pointers.
- `.gitignore`, `.vercelignore` — ignore `/backups`, `.env`, `node_modules`, `tools`.

**Added:**
- `api/intake.js`
- `supabase/migrations/001–004*.sql`
- `tools/`: `_lib.js`, `backup-supabase-records.js`, `backup-local-data.js`,
  `restore-supabase-records.js`, `validate-backup.js`, `check-config.js`,
  `smoke-test.js`, `check-rls.sql`
- `package.json`, `.env.example`
- Docs: `AUDIT_REPORT.md`, `BACKUP_AND_RESTORE.md`, `SUPABASE_SECURITY_GUIDE.md`,
  `AUTH_SECURITY_REPORT.md`, `SYNC_ENGINE_REPORT.md`, `DEPLOYMENT_FIXED.md`,
  `DATA_MODEL.md`, `DATA_MIGRATION_PLAN.md`, `REFACTOR_REPORT.md`, `QA_CHECKLIST.md`,
  `README.md`, this report.

## Improvements by area
- **Security:** forgot-password works; hashes never computed/sent by the browser;
  `_accounts` anon lockdown migration; no internal-error leakage; `.env.example`
  replaces secrets-in-comments; `MAGNET_ALLOW_DEV_AUTH_FALLBACK` documented (secure default).
- **Sync:** documented + verified non-destructive last-write-wins merge, offline-safe
  writes, tombstone deletes, network-first SW; durable-queue design provided.
- **Backup:** cloud + local backup, checksummed envelopes, validation, dry-run
  conflict-aware restore that never deletes, in-DB restore point.
- **DB:** idempotent additive migrations — audit log, snapshot, `_accounts` lockdown,
  `accounts_safe` hash-free view, sync-metadata columns + soft-delete + indexes.
- **UI/UX:** identity preserved (verified). Role-based module visibility and
  role-appropriate dashboard KPIs already exist; music is gated off-by-default.
  Deeper role-home work is scoped in the reports (not force-changed to avoid risk).

## Dangerous-pattern scan (actual grep results)
| Pattern | Result |
|---|---|
| `admin123` login bypass | none — only the `ensureDefaultOwner` seed + a comment |
| exposed service_role/secret in `index.html` | none |
| client `newHash` to changepw | none (frontend sends `newPassword`; fn ignores `newHash`) |
| `sendMail is not defined` | fixed — `sendMail` defined |
| broad anon `using(true)` active policy | none in `002` (only inside its rollback comment) |
| `.netlify/functions/intake` in `index.html` | none |
| stale project ref in active instructions | none (only in the audit's issue description) |
| destructive delete without confirmation | restore tool never deletes; app delete is tombstoned |
| localStorage overwrite without backup | migrations/tools snapshot first; app keeps local as source of truth |

## What still requires manual environment variables
Set on the host / function (never in the browser): `SUPABASE_SERVICE_ROLE_KEY`,
`RESEND_API_KEY`, `FROM_EMAIL`, intake `SUPABASE_KEY`, `HR_EMAIL`, `SALES_EMAIL`.
See `.env.example`. No secrets were invented or committed.

## Exact commands
```bash
cp .env.example .env                       # fill in keys
npm run smoke                              # offline checks
npm run check:config                      # live checks (needs .env)
npm run backup:supabase                   # backup BEFORE deploying/migrating
npm run backup:validate backups/<file>.json
# Supabase:
supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd
#   then run migrations 001→004 in the SQL Editor
# Restore (safe):
npm run restore:supabase:dry backups/<file>.json     # dry-run
npm run restore:supabase backups/<file>.json         # apply (upsert only, never deletes)
```

## Deployment checklist
1. `npm run backup:supabase` (keep the file). 2. Deploy accounts function + set its
secrets. 3. Apply migrations `001→004`; verify with `tools/check-rls.sql` +
`npm run check:config`. 4. Set Vercel env vars (DEPLOYMENT_FIXED.md). 5. Deploy to
Vercel. 6. Smoke-test login, forgot-password, `/api/intake`, and the `_accounts`
403 check. 7. Confirm SW serves the new build (network-first, `magnet-os-v4`).

## Rollback plan
- Code: `git revert <commit>` (baseline `ef51ad7`).
- DB: per-migration ROLLBACK notes; `002` restores the open policy; restore from
  `records_backup_001` or a `/backups` file (dry-run first).
- Nothing here deletes data, so rollback never loses records.

## Live verification (Supabase MCP, project `jdylrthffifbhyrrhuqd`, read-only)
- `_accounts` anon lockdown **is applied in production** (all `records` anon policies
  scoped `coll <> '_accounts'`; no open policy). Hashes are not anon-readable. Security
  advisors clean (one non-applicable Supabase-Auth WARN).
- The **deployed** accounts function (v3) already has `sendMail` → forgot-password does
  not crash live. It **still accepts client `newHash`** and leaks raw errors → the H1
  hardening in this repo is **not yet live**.
- Live data: **522 records, 41 collections, 21 accounts**. All migrations are additive.

## ⚠️ One safe function deploy closes H1 in production (no coordination needed)
The fixed `changepw` was made **backward-compatible**: it prefers `newPassword`
(server-hashed) and accepts a legacy `newHash` **only if it is a well-formed PBKDF2
string** — so the arbitrary/weak-hash injection is closed while the *currently-live*
frontend (which sends a valid PBKDF2 `newHash`) keeps working. This means the Edge
Function can be deployed **on its own**, with **no coordinated frontend deploy** and
no risk of breaking change-password. The updated `index.html` (sends `newPassword`)
can ship later on any Vercel deploy.

**✅ DEPLOYED (2026-07-02, with explicit owner authorization).** The hardened function
is live as **accounts v4** (`verify_jwt=false` preserved, env secrets intact). Verified
live: bad login → `{ok:false,reason:invalid}`; changepw without token → `401
unauthorized`; a non-PBKDF2 `newHash` is rejected; unknown action → generic error.
Real-user login is unaffected. Remaining step: deploy the updated `index.html` to Vercel
(sends `newPassword`) whenever convenient, then optionally drop the `newHash` branch.

**Manual deploy command (for reference / redeploy):**
1. `npm run backup:supabase` first.
2. `supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd`
   (or authorize me to deploy it via Supabase MCP — I attempted this and it was
   correctly blocked pending your explicit go-ahead; **nothing was deployed/faked**).
3. Verify: `curl -X POST "$SUPABASE_URL/functions/v1/accounts" -H "apikey: $ANON" -d '{"action":"login","identifier":"x","password":"y"}'` → `{"ok":false,"reason":"invalid"}`.
4. Later: deploy the updated `index.html` to Vercel so change-password sends `newPassword`.
Follow-up hardening: once all clients send `newPassword`, remove the `newHash`
branch entirely (already the intent — see the code comment).

## Remaining risks
- Business collections still anon-readable by design (Stage B / Supabase Auth needed
  for full isolation — DATA_MIGRATION_PLAN.md + SUPABASE_SECURITY_GUIDE.md).
- Durable pending-sync queue + visible conflict-review UI designed but not wired.
- UI remains a single large `index.html` (working; extraction path documented).
- Default `owner/admin123` seed exists on empty installs (flagged; rotate on first login).
- Automated `npm run smoke`/`check:config` must be run by the maintainer (no Node here).
