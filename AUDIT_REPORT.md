# Magnet OS — Phase 0 Full Project Audit

_Generated during production-stabilization pass. No application code was modified before this report._

Baseline git commit: `ef51ad7` ("chore: baseline snapshot before stabilization").

---

## 1. Current architecture summary

Magnet OS is a **single-file React PWA** (`index.html`, 7,816 lines / 862 KB) for an internal marketing/creative agency. It is **not built** — React 18.3.1 + ReactDOM + `htm` are inlined directly as production-minified scripts, and the whole UI is authored with `htm` tagged templates (no JSX/Vite/bundler). The file is internally organised into logical "modules" separated by `/* ===== crm-cloud.js ===== */`, `/* ===== crm-auth.js ===== */`, `/* ===== crm-seed.js ===== */` markers — evidence it was assembled from separate sources and can be re-split later.

Data model: **single generic `records` table** in Supabase, one row per record: `{ id text pk, coll text, data jsonb, updated_at }`. The browser reads/writes it directly with a **public anon/publishable key** (hardcoded in `index.html`). Collections are namespaced by the `coll` column (49 business collections + `_accounts` for users).

Serverless backend:
- `api/send-email.js` — Vercel function → Resend (holds `RESEND_API_KEY` server-side).
- `netlify/functions/send-email.js` — Netlify twin of the above (legacy).
- `netlify/functions/intake.js` — Netlify function for **public website forms** (candidate/lead intake) using a server-side key.
- `supabase/functions/accounts/index.ts` — **Deno Edge Function (service-role)** that performs real server-side auth: login, list, save, delete, verify, changepw, forgot. Keeps password hashes server-side and issues HMAC session tokens.

Deployment: the **live site is Vercel** (`magnet-op.vercel.app`, referenced in the accounts function and `api/send-email.js`). Netlify config is also present (`netlify.toml`, `_redirects`) as a legacy/alternate target.

PWA: `manifest.json` + `serviceworker.js` (cache `magnet-os-v4`, network-first for the HTML shell, stale-while-revalidate for static assets, **cross-origin never cached** so Supabase/Resend are always live). A `file://` fallback embeds a base64 icon + blob manifest for single-file use.

---

## 2. Frontend modules (inside `index.html`)

| Area | Key symbols | Lines (approx) |
|---|---|---|
| Design tokens / CSS | `:root` brand vars, responsive | 14–1073 |
| Bootstrap / cloud config | `tia_agency_os_cloud`, `enabledModules` seed | 1076–1138 |
| PWA / SW registration | inline IIFE | 1108–1138 |
| React/ReactDOM/htm (inlined) | — | 1140–1520 |
| `store` (localStorage wrapper) | `store.get/set/del` + `_mem` fallback | 1531 |
| Roles & permissions | `ROLES`, `ROLE_ALIAS`, `ROLE_RESPONSIBILITIES` | 1683–1760 |
| Collections | `COLLECTIONS` (49 colls) | 2227 |
| Cloud/data layer | `cloudLoadAll`, `cloudUpsert`, `cloudDelete`, `cloudPushAll`, `mergeDB`, `mergeColl`, `collSame` | 2960–3096 |
| Email | `sendEmail` (Vercel-first, Netlify fallback) | 3030 |
| Auth (crypto) | `hashPassword`, `verifyPassword`, PBKDF2 150k iters, legacy compat | 3112–3159 |
| Auth (accounts) | `acctApi`, `authLogin`, `ensureDefaultOwner`, `cloudPushUsers/PullUsers`, `syncUsersFromCloud` | 2961–3294 |
| Session | `getSessionUser`, `setSessionUser`, `clearSessionUser`, `getAcctToken` | 2963–3254 |
| DB load / seed | `loadDB`, `seed` | 3303–3429 |
| Records CRUD | `upsertRecord`, `save`, `submit` | 4459 |
| Login flow | `doLogin`, `doLogout`, `recordLogin/Logout` | 4295–4327 |
| Cloud UI actions | `connectCloud`, `syncNow`, `pullFromCloud`, `signInCloud`, `restoreSnapshot`, `setBackupPrefs` | 4721–4768 |
| Backup Center | `BackupCenterView`, `runAutoBackup`, `getBackupMeta` | 2656–2685, 7106 |
| Login / password reset UI | `LoginScreen`, `PwResetForm` | 7198, 7659 |
| Views | Workload, ScopeAccounts, profiles, roles/permissions, member assignment | 5832–7734 |

Role-based visibility already exists via `enabledModules` (per-install module list) + `role` + `dataScope` (`all` vs scoped) + assigned clients/tasks.

---

## 3. Backend / API modules

- **`supabase/functions/accounts/index.ts`** (service-role, `verify_jwt` off, auth in-body). Actions: `login`, `list`, `save`, `delete`, `verify`, `changepw`, `forgot`. Uses PBKDF2 verify + rehash-on-login, HMAC-signed session tokens (30-day exp), `sanitize()` strips `passwordHash`/`verifyToken`, bootstrap-first-account rule, non-admin self-write-only guard. **Two defects — see Risks C1, H1.**
- **`api/send-email.js`** (Vercel) — clean; requires `RESEND_API_KEY`; returns explicit error if missing; CORS `*`.
- **`netlify/functions/send-email.js`** — functional twin (legacy target).
- **`netlify/functions/intake.js`** — public-form writer, whitelists `candidate`→`candidates` / `lead`→`leads` only, field-clips, honeypot, optional email alerts. **Project-ref inconsistency — see Risk M1.** Netlify-only — **no Vercel equivalent — see Risk M2.**

---

## 4. Database / storage usage

**Supabase (`records` table).** SQL assets present:
- `supabase-schema.sql` — creates table, indexes (`coll`, `updated_at`, GIN on `data`), `set_updated_at` trigger, RLS enabled with **fully-open anon SELECT/INSERT/UPDATE/DELETE** (`using (true)`).
- `supabase-accounts-lockdown.sql` — **Stage A** hardening: anon may touch every collection **except `_accounts`** (`coll <> '_accounts'`), plus revokes leftover SECURITY DEFINER functions. Reversible. **Not yet known to be applied in production.**
- `supabase-auth-migration.sql` — **Stage B** blueprint: anon read only public collections, insert only leads/candidates; full per-user isolation deferred to Supabase Auth.

**LocalStorage keys** (namespaced, never collide with business data):
- `tia_agency_os_cloud` — `{url, key}` Supabase config (seeded with live project + anon key).
- `tia_agency_os_appsettings` — `enabledModules`, `currency`, etc.
- `tia_agency_os_v2` — main CRM database (records by collection).
- `tia_users` / `tia_current_user` / `tia_session` / `tia_permissions` / `tia_auth_settings` — auth store.
- `tia_acct_token` — HMAC session token (also mirrored to `sessionStorage`).
- Backup-Center snapshot/meta keys.

`store` degrades to an in-memory `_mem` object if `localStorage` throws (private mode / quota), so the app never hard-crashes on storage failure.

---

## 5. Auth flow

1. **Login** (`authLogin`): PRIMARY = `acctApi('login')` → Edge Function verifies hash **server-side**, returns sanitized user + HMAC token. FALLBACK (function unreachable) = `syncUsersFromCloud()` (anon read of `_accounts`) then local `verifyPassword`. Legacy hashes are transparently re-hashed to PBKDF2 on success.
2. **Default owner**: `ensureDefaultOwner()` creates `owner / admin123` on a truly-empty install, flagged `isDefaultPassword:true` with a standing warning.
3. **Change password** (`PwResetForm`): PRIMARY = `acctApi('changepw', {token, currentPassword, newHash})`. **Frontend currently computes the hash and sends `newHash`** (Risk H1).
4. **Forgot password**: `acctApi('forgot', {identifier})` → Edge Function generates a temp password, is supposed to email it. **`sendMail` is undefined in the function → 500 crash** (Risk C1).
5. **Session**: `remember` → `localStorage`; otherwise `sessionStorage`. Token gates account writes.

No dev/auto-login bypass exists; there is no `MAGNET_ALLOW_DEV_AUTH_FALLBACK` flag yet (the "fallback" is the anon/legacy verification path, not a credential bypass).

---

## 6. Sync flow

- **Load**: `cloudLoadAll` pulls all rows → groups by `coll`. `mergeDB(local, cloud)` keeps newest per id by `updatedAt`/`createdAt`, drops `_del` tombstones. **Non-destructive** — a missing record on one side is preserved; only explicit deletes (tombstones) remove.
- **Write**: `upsertRecord` writes locally, then `cloudUpsert` (PostgREST `on_conflict=id`, `merge-duplicates`) **fire-and-forget inside try/catch** — offline-safe (never throws) but **no durable retry queue**: a write that fails while offline is only reconciled by the next `cloudPushAll`/poll+merge, not individually retried.
- **Poll/realtime**: `cloudLoadColl` + `collSame` short-circuit re-renders when nothing changed. `__moDiag()` console helper reports realtime/poll/last-sync state.
- Deletes: `cloudDelete` removes the row; merge drops tombstones so deletes don't resurrect.

Effectively **last-write-wins by timestamp, non-destructive on absence**. There is no explicit conflict *detection/review* surface and no persisted pending-write queue (Risk L1).

---

## 7. Risks (ranked)

### CRITICAL
- **C1 — `forgot` password crashes.** `supabase/functions/accounts/index.ts:115` calls `sendMail(...)`, which is **never defined** in the file. The `forgot` action throws → caught by the outer `try` → returns HTTP 500. Forgot-password is completely broken and leaks an internal error string. _(Matches brief issue #6; Phase 11 pattern `sendMail is not defined`.)_

### HIGH
- **H1 — Client-supplied password hash.** Frontend `PwResetForm` computes `newHash=await AUTH.hashPassword(np)` and sends it to `changepw`; the Edge Function (`index.ts:105`) accepts `body.newHash` verbatim. Hashing is **not enforced server-side** — a crafted request can set an arbitrary stored hash for the caller's own account. _(Brief Phase 3 / Phase 11 pattern `newHash`.)_
- **H2 — `_accounts` may be world-readable.** If only `supabase-schema.sql` was applied (open anon), **anyone with the public key can `SELECT` every password hash** and `INSERT` a fake Owner. The fix (`supabase-accounts-lockdown.sql`) exists but its production-applied status is unverified. _(Brief issues #3, #5.)_

### MEDIUM
- **M1 — Supabase project mismatch.** App + accounts function + main docs use project **`jdylrthffifbhyrrhuqd`**; `DEPLOYMENT.md`, `BRIEFS_README.md`, and `intake.js`'s SETUP comment reference **`ksunojpdzunyqrxdmogd`**. `intake.js` code defaults to `jdyl…` while its own comment says `ksuno…`. Guaranteed to misconfigure someone. _(Brief issue #10.)_
- **M2 — Vercel/Netlify function mismatch.** Live site is Vercel, but the public **intake** endpoint exists only as a Netlify function. On Vercel there is no working `/api/intake` and `/.netlify/functions/intake` 404s. _(Brief issue #7.)_
- **M3 — Default `owner/admin123`.** Convenient but a known credential; mitigated by `isDefaultPassword` + warning, but not force-rotated and not env-gated. _(Brief issue #4.)_
- **M4 — No `.env.example` / secrets only in comments.** Required env vars (`RESEND_API_KEY`, `FROM_EMAIL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `HR_EMAIL`, `SALES_EMAIL`) are documented only inline. No machine-checkable config surface.

### LOW
- **L1 — No durable pending-sync queue / explicit conflict review.** Offline writes are safe but silently reconciled in bulk; there's no visible "pending changes / conflict detected" queue with per-item retry. _(Brief issue #8.)_
- **L2 — Monolithic `index.html`.** Fragile to maintain; already section-marked so a later extraction is low-risk. _(Brief issue #1.)_
- **L3 — Music autoplay.** A hidden YouTube player uses `autoplay:1` but is gated by `musicGetOn()` (off unless the user enabled it), so it does not autoplay for new users. Acceptable; noted for Phase 7.
- **L4 — `magnetrun.html`** (1.35 MB) is a second, older full copy of the app in the repo root — dead weight that can confuse deploys. Not referenced by any config.

---

## 8. Specific files / functions to change (mapped to phases)

| Fix | File · function | Phase |
|---|---|---|
| Define `sendMail` (Resend) so `forgot` works | `supabase/functions/accounts/index.ts` · `forgot` | 3 |
| Stop accepting client `newHash`; hash server-side only | `supabase/functions/accounts/index.ts` · `changepw` | 3 |
| Send `newPassword` (not `newHash`) | `index.html` · `PwResetForm` change-password handler | 3 |
| Add `MAGNET_ALLOW_DEV_AUTH_FALLBACK` gate + safe error messages | `accounts/index.ts`, docs | 3 |
| Add Vercel `api/intake.js`; document `/api/intake` | new file | 5 |
| Correct project ref default + comment | `netlify/functions/intake.js` | 5, 10 |
| Idempotent, additive migrations (audit cols, soft-delete, indexes, RLS) | `supabase/migrations/*` | 2 |
| Backup/restore/validate tooling + `package.json` scripts | `tools/*`, `package.json` | 1 |
| `.env.example`, corrected docs, reports | repo root | 3,5,8,10,11 |

---

## 9. Assumptions

1. Live production project is **`jdylrthffifbhyrrhuqd`** (matches the app, the accounts function deploy comment, and `api/send-email.js`'s `magnet-op.vercel.app`). `ksunojpdzunyqrxdmogd` is treated as **stale documentation**.
2. Primary deployment target is **Vercel**; Netlify assets are kept as optional legacy.
3. The Supabase **anon/publishable key** in `index.html` is intentionally public (internal-team model); real isolation is the deferred Stage B (Supabase Auth).
4. No production DB credentials, service-role keys, or Resend keys are available in this environment — all such values are surfaced via `.env.example` + setup docs, never invented or committed.
5. Existing production data lives in the `records` table and in users' browsers (localStorage). **Nothing here drops tables or deletes rows**; all DB changes are additive/idempotent.
