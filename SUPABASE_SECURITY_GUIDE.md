# Magnet OS — Supabase Security Guide

How the database is protected, what the migrations change, and how to verify and
roll back. **No migration here drops a table or deletes a row.**

> This document describes the historical Stage-A internal-app model. It is not a
> SaaS security target. The current authoritative plan is in `docs/DATABASE.md`,
> `docs/AUTH_ARCHITECTURE.md`, and `docs/PRODUCTION_READINESS.md`. Never provision
> a new environment from the loose root SQL files.

## The security model (read this first)

The app is a **browser client that talks to Postgres with the PUBLIC anon key**
(shipped in `index.html`). That key can only ever act as the `anon` Postgres role,
so RLS on the `anon` role is the real boundary. Two staged levels:

- **Stage A (applied by these migrations, non-breaking):** block `anon` from the
  `_accounts` collection so password hashes can't be read and fake Owners can't be
  inserted. Every other collection stays anon-accessible, so the app keeps working.
  Sensitive account operations go through the **service-role Edge Function**
  (`supabase/functions/accounts`), which bypasses RLS.
- **Stage B (documented, NOT applied — app-breaking):** migrate sign-in to
  **Supabase Auth** (per-user JWT), send that token from the data layer, and make
  RLS depend on `auth.uid()`/role so finance/HR/employee collections become
  invisible to anon. This changes the app's data layer and must be done on a branch.
  Blueprint: `supabase-auth-migration.sql` + `DATA_MIGRATION_PLAN.md`.

> Why not hide `invoices`/`employees`/`payments` from anon now? Because the running
> app reads them directly with the anon key. Blocking them = breaking the live app.
> That protection is real only after Stage B. This is called out honestly rather
> than shipping a migration that would take the app down.

## What each migration does

| File | Effect | Breaking? |
|---|---|---|
| `supabase/migrations/001_backup_and_audit.sql` | Ensures table/indexes/trigger; adds `migration_audit` log; snapshots current rows into `records_backup_001` | No |
| `supabase/migrations/002_records_rls_hardening.sql` | anon may touch every collection **except `_accounts`**; revokes leftover SECURITY DEFINER funcs | No (deploy Edge Function first) |
| `supabase/migrations/003_accounts_security.sql` | Adds `accounts_safe` view (hash-free) + server-side `serverUpdatedAt` stamp on account writes | No |
| `supabase/migrations/004_activity_and_sync_metadata.sql` | Adds nullable `created_at/created_by/updated_by/deleted_at` columns + fill trigger + indexes; backfills; soft-delete surface | No |

The older loose scripts (`supabase-schema.sql`, `supabase-accounts-lockdown.sql`,
`supabase-auth-migration.sql`) are superseded by `supabase/migrations/*` but kept
for reference. `002` is the consolidated, canonical version of the lockdown.

## How to apply

Preconditions:
1. Deploy the accounts Edge Function **before** `002` (so account ops survive the
   lockdown):
   ```bash
   supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd
   # Set its secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, FROM_EMAIL
   ```
2. Take a backup: `npm run backup:supabase`.

Historical migrations were applied in order. For future changes, use the
Supabase CLI migration workflow after backup/staging; do not paste an incomplete
bundle into the SQL Editor:
```
001_backup_and_audit.sql
002_records_rls_hardening.sql
003_accounts_security.sql
004_activity_and_sync_metadata.sql
```

## How to verify RLS

Run `tools/check-rls.sql` in the SQL Editor, then the anon probes:

```bash
# _accounts must now be 401/403 for the ANON key:
curl -s -o /dev/null -w "%{http_code}\n" \
  "$SUPABASE_URL/rest/v1/records?select=id&coll=eq._accounts&limit=1" -H "apikey: $ANON_KEY"
# SaaS target: clients must return no private rows to anon:
curl -s -o /dev/null -w "%{http_code}\n" \
  "$SUPABASE_URL/rest/v1/records?select=id&coll=eq.clients&limit=1"    -H "apikey: $ANON_KEY"
```

Or just run `npm run check:config`, which performs the `_accounts` exposure check,
the records reachability check, and the Edge Function/email checks automatically.

## Anon key vs service role — who can do what

| Actor | Key | Can read `_accounts`? | Can read business colls? |
|---|---|---|---|
| Legacy browser app | anon (public) | **No** (after 002) | Yes — **P0, not SaaS-safe** |
| Target browser app | publishable key + user JWT | No | Only tenant/capability-authorized rows |
| Edge Function `accounts` | service_role (secret) | Yes (bypasses RLS) | Yes |
| Backup/restore tools | service_role preferred | Yes | Yes |
| Public intake function | service_role or anon | No (only writes leads/candidates) | writes only |

## Rollback safety

Never restore fully-open anonymous business-data access as an outage workaround.
Rollback must promote the previous compatible application and its reviewed policy
set together. If authentication is unavailable, show a controlled outage/recovery
state and repair Auth; do not expose employee, finance, client, or lead data.
