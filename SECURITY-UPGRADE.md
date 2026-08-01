# Magnet OS — Security & Fixes (this pass)

This documents everything changed in this pass, what you must do to finish, and
the one remaining architectural item.

> 📌 **A newer stabilization pass followed this one.** See
> **[FINAL_ENGINEERING_REPORT.md](FINAL_ENGINEERING_REPORT.md)** for the latest
> changes (forgot-password `sendMail` fix, server-only password hashing,
> `/api/intake`, backup/restore tooling, idempotent RLS migrations). The service
> worker cache is now **`magnet-os-v4`**. New guides:
> **[SUPABASE_SECURITY_GUIDE.md](SUPABASE_SECURITY_GUIDE.md)** ·
> **[AUTH_SECURITY_REPORT.md](AUTH_SECURITY_REPORT.md)**.

## ✅ Fixed in code (safe, no action needed beyond deploy)

| # | Issue | What changed |
|---|-------|--------------|
| Email | `/.netlify/functions/send-email` 404s on Vercel | Added Vercel function `api/send-email.js`; `sendEmail()` now tries `/api/send-email` first, falls back to Netlify. |
| Service worker | Cache-first served stale app + data (needed hard-refresh) | Rewrote `serviceworker.js`: network-first for HTML, never caches cross-origin (Supabase) data, deletes old caches. Bumped to `magnet-os-v3`. |
| SPA / headers | No Vercel config | Added `vercel.json` (SPA rewrite + security headers: nosniff, frame, referrer, HSTS). |
| XSS | Document builders injected record data raw into HTML | Added `esc()` and escaped every dynamic value in invoice/receipt/proposal/quotation/contract builders. |
| Passwords | Unsalted SHA-256 | Now salted **PBKDF2-SHA-256 (150k iters)**, backward-compatible; old hashes auto-upgrade on next login. |
| Tokens | Brief/verify tokens + temp password used `Math.random()` | Added `randToken()` (crypto). Brief links, verify links, and emailed temp passwords are now unguessable. |
| IDs | `uid()` had 4 random chars (collision risk) | Now `crypto.randomUUID()` with a wider fallback. |
| Router | Modules rendered without an access check | `renderRoute()` now blocks any canonical module the user can't see. |
| Delete | `PROTECTED_DELETE` enforced only on the button | Now also enforced inside `deleteRecord()` (invoices/payments can never be deleted). |
| Payroll | Logging in on >26 days overpaid salary | `earned` is now capped at the month's work-days. |
| Net profit | Profitability and Partners screens disagreed | Profitability now subtracts monthly fixed costs too — both screens match. |
| Invoice total | `invTotal` ignored items & discount; PDF used them | `invTotal` now mirrors the printed invoice exactly. |
| Dates | `YYYY-MM-DD` shown a day early in some timezones | `fmtDate` parses bare dates as local midnight. |
| Partners | Settle-up silently mis-split with 3+ partners | Now blocked unless exactly 2 partners. |
| Cleanup | Duplicate `meetings` form schema | Removed the dead first definition. |

## ⚙️ You must do (one-time, in the dashboards)

1. **Vercel env vars** (Project → Settings → Environment Variables), then redeploy:
   - `RESEND_API_KEY` = your Resend key  (required for any email to work)
   - `FROM_EMAIL` = `Magnet OS <onboarding@resend.dev>` (or your verified sender)
2. **Rotate the Vercel token** you pasted in chat — it is now exposed. Create a
   new one and delete the old at vercel.com/account/tokens.
3. **Set a strong Owner password** during the first-install setup (and change it
   later from Profile when needed). It
   re-hashes to PBKDF2 automatically.

## 🔴 Remaining (architectural — needs your Supabase + testing)

Findings #1–3 (anyone with the public anon key can read/modify ALL data and read
password hashes) **cannot be fully closed in the client** — the authenticated app
itself uses the public anon key for everything. The real fix is a migration that
must be tested against your Supabase before going live, so it is delivered as a
ready plan, not silently shipped:

- **`supabase-auth-migration.sql`** — staged RLS lockdown (Stage A closes
  credential theft + account takeover; Stage B is full per-user isolation via
  Supabase Auth).
- Stage A needs small server functions (service-role key in Vercel env) to handle
  login / account-sync / email-verify and public form writes, so the browser no
  longer needs anon access to `_accounts`.

Do **not** apply `supabase-auth-migration.sql` until those server functions are in
place, or the app will lose DB access for the restricted collections. Tell me when
you want to do this phase and I'll wire it up against a preview deploy so we can
verify login still works before flipping the live site.
