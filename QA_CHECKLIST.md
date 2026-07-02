# Magnet OS — QA Checklist (Phase 9)

## One-command checks

```bash
npm run smoke          # offline: syntax of all server/tool JS, JSON parse, dangerous-pattern scan
npm run check:config   # live: Supabase reachability, _accounts exposure, accounts fn, email endpoint
```

`smoke` needs no network/secrets. `check:config` reads `.env` (copy from
`.env.example`). Also run `tools/check-rls.sql` in the Supabase SQL Editor after
applying migrations.

> Note: this environment had no Node runtime, so the maintainer must run
> `npm run smoke` / `check:config` once on a Node 18+ machine. The scripts are
> written and committed; they were not executed here (nothing is claimed as
> "passing" that wasn't run — see FINAL_ENGINEERING_REPORT.md).

## Manual QA (do these before a release)

| # | Test | Steps | Expect |
|---|---|---|---|
| 1 | **Login** | Sign in with a valid user | Reaches dashboard; token stored |
| 2 | **Logout** | Click logout | Returns to login; session cleared |
| 3 | **Invalid login** | Wrong password | Generic "invalid" — no hint whether user exists |
| 4 | **Role visibility** | Log in as a non-admin (e.g. Designer) | Admin/finance modules hidden; owner sees all |
| 5 | **Create/edit/delete client** | CRM → Clients | Persists locally + cloud; delete tombstones (no resurrect) |
| 6 | **Create/edit/delete task** | Tasks | Same as above |
| 7 | **Offline create** | DevTools → Offline; create a client | Saved locally, no error/crash |
| 8 | **Reconnect sync** | Go back online | Local change appears in cloud (merge upsert); nothing lost |
| 9 | **Backup export** | Settings → Backup Center → Export, or `npm run backup:supabase` | JSON downloaded / written to `/backups` with checksum |
| 10 | **Backup restore dry-run** | `npm run restore:supabase:dry backups/<file>.json` | Reports create/update/conflict; writes nothing |
| 11 | **Forgot password** | Login → Forgot password → enter email | "If the account exists…" message; **no crash/500**; email arrives if configured |
| 12 | **Change password** | Profile → change password; watch Network tab | Request body has `newPassword`, **not** `newHash`; succeeds |
| 13 | **Public form** | POST to `/api/intake` (see DEPLOYMENT_FIXED.md) | `{ok:true}`; leads/candidate + notification row created |
| 14 | **Finance sensitive access** | As anon key, `SELECT _accounts` after migration 002 | **403** (hashes not exposed). Business colls still 200 |
| 15 | **Mobile responsive** | Preview at 375px | Layout usable; nav collapses; cards stack |
| 16 | **PWA install** | Load on HTTPS; install prompt | Installs; icons/manifest correct |
| 17 | **SW freshness** | Deploy new build | Network-first shell loads new code without hard refresh; old caches purged |

## Acceptance criteria — status
- [x] One command checks obvious issues (`npm run smoke`, `check:config`).
- [x] Server/tool JS has no syntax errors (validated via `node --check` in `smoke`).
- [x] No missing function references (`sendMail` defined; scan enforces it).
- [x] Service worker is network-first for the shell and purges non-current caches
      (`serviceworker.js`, cache `magnet-os-v4`) — no permanently-stale cache.
