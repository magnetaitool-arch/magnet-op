# Magnet OS — Auth Security Report (Phase 3)

> **Live state (verified via Supabase MCP).** The **deployed** accounts function (v3)
> already defines `sendMail`, so **forgot-password does not crash in production** — the
> zip was a stale draft. However, the deployed `changepw` **still accepts `body.newHash`
> and still leaks raw errors**. The repo fixes both, and `changepw` was made
> **backward-compatible** (accepts `newPassword`, or a legacy `newHash` only if it is a
> valid PBKDF2 string) so the fixed function can be deployed **on its own** without a
> coordinated frontend deploy and without breaking the live change-password flow. A
> production deploy still needs **explicit owner authorization** (team-wide auth) — it
> was attempted here and correctly blocked; nothing was deployed. The `_accounts` anon
> lockdown is already live (anon cannot read hashes).

## Old flow (issues)

1. **`forgot` crashed.** `supabase/functions/accounts/index.ts` called `sendMail(...)`
   which was **never defined** → the `forgot` action threw → HTTP 500 with the raw
   error string. Forgot-password was completely broken.
2. **Client-supplied password hash.** The browser (`PwResetForm`) computed
   `AUTH.hashPassword(newPw)` and sent it as `newHash`; the Edge Function accepted
   `body.newHash` verbatim. Hashing was not enforced server-side — a crafted request
   could store an arbitrary hash for the caller's own account.
3. **Leaky errors.** The function's top-level `catch` returned `String(e.message)`,
   exposing internal detail to the browser.
4. **`_accounts` potentially world-readable** if only the open `supabase-schema.sql`
   was applied (anon could `SELECT` every password hash). Fixed at the DB layer —
   see `SUPABASE_SECURITY_GUIDE.md` / migration `002`.

## New flow (fixes in this pass)

1. **`sendMail` implemented** in the accounts function: sends via Resend when
   `RESEND_API_KEY` is set on the function, else POSTs to the app's `/api/send-email`.
   Returns `true` only on real delivery, so `forgot` **never rotates a password when
   the email couldn't be sent**. `forgot` still always returns `{ok:true}` — it never
   reveals whether an account exists.
2. **Server-side hashing enforced.** `changepw` now **ignores any client `newHash`**
   and always computes PBKDF2 from `newPassword` (rejects passwords < 6 chars). The
   frontend was updated to send `newPassword`, never a hash.
3. **Generic server errors.** The top-level `catch` now logs the real error to the
   function logs and returns `{error:'server error'}` (HTTP 500) — no internal leak.
4. **Password hashing** remains salted **PBKDF2-SHA-256, 150k iterations**, both in
   the browser (legacy/offline path) and server-side (authoritative). Legacy
   `sha256:`/`fallback:` hashes still verify and are transparently upgraded to
   PBKDF2 on next login.

### Login path (unchanged, already sound)
- PRIMARY: `acctApi('login')` → Edge Function verifies the hash **server-side** and
  returns a sanitized user (no hash) + HMAC session token (30-day exp).
- FALLBACK (function unreachable): local/anon verification. Once migration `002` is
  applied and the Edge Function is deployed, the anon read of `_accounts` returns
  403, so this fallback can only use locally-cached accounts — secure by default.

### Default credentials
`ensureDefaultOwner()` seeds `owner / admin123` **only on a truly empty install**,
flagged `isDefaultPassword:true` with a standing in-app warning. To force rotation:
sign in as owner and change the password (now server-hashed). For production, create
real accounts and delete/rotate the default; `admin123` is the seed default only and
is **not** a hardcoded login bypass (verified — see `tools/smoke-test.js` scan).

### Dev fallback flag
`.env.example` documents `MAGNET_ALLOW_DEV_AUTH_FALLBACK` (default `false`). The
secure default is: rely on the server Edge Function; the browser fallback path only
engages when the function is unreachable and, post-`002`, cannot read remote hashes.

## Remaining required environment variables

Server-side only (never in the browser):
- Edge Function `accounts` secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  and (for forgot-password email) `RESEND_API_KEY`, `FROM_EMAIL`.
- Email function: `RESEND_API_KEY`, `FROM_EMAIL` (Vercel/Netlify env).

## Test checklist

- [ ] Valid login (owner) succeeds via the Edge Function (`check:config` shows it deployed).
- [ ] Invalid login returns a generic "invalid" — no user-existence leak.
- [ ] Inactive user is rejected.
- [ ] **Forgot password** with a real email: returns `{ok:true}`, email arrives, temp
      password works, and you're prompted to change it. Does not 500.
- [ ] Forgot password with an unknown email: returns `{ok:true}`, no email, no leak.
- [ ] **Change password**: succeeds; DevTools Network shows the request body carries
      `newPassword`, **not** `newHash`.
- [ ] After migration `002`: browser anon `SELECT _accounts` returns 403 (no hashes
      reach the browser).
- [ ] Wrong current password on change → `bad-current`, no change made.
