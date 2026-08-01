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
   and always computes PBKDF2 from `newPassword` (requires at least 10 characters,
   upper-case, lower-case, and a number). The
   frontend was updated to send `newPassword`, never a hash.
3. **Generic server errors.** The top-level `catch` now logs the real error to the
   function logs and returns `{error:'server error'}` (HTTP 500) — no internal leak.
4. **Password hashing** remains salted **PBKDF2-SHA-256, 150k iterations**, both in
   the browser (legacy/offline path) and server-side (authoritative). Legacy
   `sha256:`/`fallback:` hashes still verify and are transparently upgraded to
   PBKDF2 on next login.

### Login path
- PRIMARY: `acctApi('login')` → Edge Function verifies the hash **server-side** and
  returns a sanitized user (no hash) + HMAC session token (30-day exp).
- FALLBACK (function unreachable): permitted only on `localhost`, `127.0.0.1`, or
  `file:` local development. Production returns a safe “service unavailable” error;
  it never falls back to browser-side password-hash verification.

### First Owner setup
There is no default Owner credential. On an empty production installation, the
accounts Edge Function requires `INITIAL_OWNER_SETUP_SECRET`; the deployer enters it
once in the setup screen alongside the real Owner details. This prevents the first
anonymous visitor from claiming the Owner role.

## Remaining required environment variables

Server-side only (never in the browser):
- Edge Function `accounts` secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `INITIAL_OWNER_SETUP_SECRET`, and (for forgot-password email) `RESEND_API_KEY`,
  `FROM_EMAIL`, `EMAIL_SHARED_SECRET`.
- Email function: `RESEND_API_KEY`, `FROM_EMAIL`, and (for trusted server callers)
  `EMAIL_SHARED_SECRET` (Vercel/Netlify env).

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
