# Magnet OS — Handover / Continue in a new chat

> **2026-08-10 stabilization candidate:** see [SAAS_READINESS_REPORT.md](SAAS_READINESS_REPORT.md).
> The current branch adds universal audit dates, configurable attendance rules,
> automatic/manual employee reports, explicit payroll payment confirmation, and
> tracked task/payslip/report email delivery. Latest checks: 46 smoke + 24 email
> security + 26 static security passed with zero failures. Public multi-tenant
> SaaS remains blocked on Auth/JWT workspace isolation and strict business-data RLS.

> **2026-08-10 incident root cause:** Supabase egress reached 16.29/5 GB because the
> browser fallback downloaded the whole records table every 5 seconds. The fallback now
> downloads deltas every 30 seconds. Accounts Edge Function v8 is live and health-checked;
> a fresh browser now detects existing accounts without exposing the private roster.
> Business data is present; the latest validated backup contains 1,444 records. The
> Supabase quota/plan still has to be resolved to guarantee uninterrupted service.

> 📌 **Start here after the stabilization pass:** read **[README.md](README.md)** and
> **[FINAL_ENGINEERING_REPORT.md](FINAL_ENGINEERING_REPORT.md)**. Before deploying,
> back up (`npm run backup:supabase`) and follow **[DEPLOYMENT_FIXED.md](DEPLOYMENT_FIXED.md)**.

## What this is
**Magnet OS** — a single-file agency CRM/operating system for "Magnet".
- Whole app lives in **`index.html`** (React via htm/babel, no build step).
- Public website forms helper: `netlify/functions/intake.js` (+ `send-email.js`).
- **Live:** https://magnet-op.vercel.app  · new installs create their Owner through the secure setup screen (no default login)
- Deployed on **Vercel** (project `magnet-op`, team `magnetaitool-archs-projects`).
- Data: **Supabase** project `jdylrthffifbhyrrhuqd` via the public/anon key (no Supabase Auth — the app authenticates users in a local/`_accounts` store synced to the `records` table).

## How to continue in ANOTHER chat
1. **Upload `Magnet-OS-FINAL.zip`** (sent with this file) to the new chat.
2. Tell it: *“This is Magnet OS (single-file `index.html`). Continue building it. Deploy to Vercel after changes.”*
3. To deploy, it needs a **Vercel access token** (vercel.com/account/tokens), then:
   ```bash
   npm i -g vercel
   vercel deploy --prod --yes --scope magnetaitool-archs-projects --token=YOUR_TOKEN
   ```
   (The app is static; Vercel serves `index.html`. `.vercelignore` keeps the deploy clean.)
4. After every edit: quick syntax check of the inline scripts, then deploy + hard-refresh.

> Note: git push to GitHub is blocked in this environment, so the source isn’t on GitHub — the ZIP is the source of truth. If GitHub write access is granted, push branch `claude/trusting-euler-951myb` and open a PR.

## Conventions
- Single file; edit `index.html`. Reuse existing helpers: `createRecord/updateRecord/deleteRecord`, `ctx.canDelete/ctx.delRec`, `DataTable`, `Panel`, `Head`, `KPI`, `money`, `todayISO` (local date), `fmtDate/fmtDateTime`, `Kanban`, `getPartners`, `userSeesModule/userCanEditSection`.
- Add a module = register in: `COLLECTIONS`, `SECTIONS`, `VIEW`/`EDIT`, `MODULE_CATALOG`, `NAVGROUPS`, `FOCUSED_DEFAULT`, the bootstrap `enabledModules` + migration, a route `case`, and `FORM_SCHEMAS`.
- Default currency **EGP**. Finance/HR screens are **English**; the client brief page (`?brief=`) is intentionally **Arabic**.

## Modules built (this session)
CRM/Leads, Clients (+ **Scope & Accounts** tab), Projects, Tasks & Deliverables (Trello boards, permission-gated), **Recruitment (ATS)**, Employees/HR, **Attendance & Payroll** (auto check-in on login + monthly salary summary, gated by `canSeeSalary`), **Finance** (Invoices/Payments/Expenses with review, **Fixed Costs & Subscriptions**, **Partners & Settlement** 50/50 with per-item settle + history, Profitability), **Plans & Goals** (Weekly/Monthly/Q1–Q4/Yearly tracker), **Campaigns** (public lead form `?form=`), **Client Briefs** (`?brief=`), **Email verification** (`?verify=`), Notifications (+ sound), Gamification (Leaderboard, Arcade, **Magnet Run** `/magnetrun.html`), **per-employee Access** (Hidden/View/Edit), profile photo + bio.

## Public links
- Campaign lead form: `…/?form=SLUG`  → creates a **Lead** in CRM (source = campaign) + Sales notification.
- Client brief: `…/?brief=TOKEN`  → fills the **Client Briefs** record.
- Email verify: `…/?verify=TOKEN`.

## Security to-do (recommended next)
- Lock down **Supabase RLS** on the `records` table (anon = insert-only, limited colls; deny finance reads/writes to anon). The app uses the anon key broadly, so real isolation needs Supabase Auth — flagged, not done.
- **Rotate the Vercel token** that was shared in chat.

---

# Security review — 2026-07-30 (review pass, NOT deployed)

A full-project security review was run over the uncommitted hardening work. **Nothing
was deployed, committed, or pushed**, and no production data or schema was changed.

## Verified by reading the source (26/26 checks pass)

Run it yourself — it needs only Python, no Node:

```bash
python3 tools/verify-security.py     # or: npm run verify:security
```

| Area | Result |
|---|---|
| Built-in `owner` / `admin123` account | removed — `ensureDefaultOwner()` no longer creates anything |
| First Owner | must be created through the setup screen and is rejected server-side unless `bootstrapSecret` matches `INITIAL_OWNER_SETUP_SECRET` (missing secret ⇒ **fails closed**, 403 `setup-required`) |
| Password policy | 10+ chars, upper + lower + digit — enforced **client-side and again in the Edge Function**, and by the bulk "reset team passwords" action |
| Production login fallback | removed — browser-side hash verification only runs on `file:`/`localhost`; production returns `reason:'unavailable'` |
| Email endpoints (Vercel + Netlify) | exact origin allow-list (no `*.vercel.app`), origin-less traffic needs `EMAIL_SHARED_SECRET`, payload validated (address format, ≤10 recipients, subject ≤200 and CR/LF-free ⇒ no header injection, body ≤100 KB), disallowed origins are not reflected in CORS |
| Secrets in the shipped frontend | none. `index.html`, `serviceworker.js`, `manifest.json` are clean. (`eyJ…` strings inside `magnetrun.html` are base64 game assets, not JWTs — verified by decoding.) The Supabase **publishable/anon** key is present by design. |
| Security headers | CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy all set in `vercel.json`; CSP pins `object-src 'none'` and `base-uri 'self'` |

## What could NOT be tested, and why

- **The Node commands were run using the bundled Node runtime** (v24.14.0), even though
  `node`/`npm` are not available on the ordinary shell PATH. `tools/smoke-test.js` passed
  34 checks and `tools/security-test.js` passed 17 checks. `tools/verify-security.py`
  additionally passed 26 static checks (with one expected CSP warning).
- **Live endpoint behaviour** (real 403s, CORS headers on the wire) — needs a deployment.
- **UI/mobile/RTL/dark-mode sweep and per-feature CRUD+permission testing** — not performed
  in this pass; it needs a deployed build and one login per role.

## Live security state (read-only checks against production)

| Item | State |
|---|---|
| `records` endpoint with the anon key | responds with HTTP 200; the app still relies on anon-key access for business data |
| `_accounts` collection with the anon key | returned no rows — RLS filtering is active for account hashes |
| RLS policies, JWT adoption, and collection-level finance restrictions | **not independently verified from this repository**; verify in the Supabase dashboard or with a service-role, read-only policy query before relying on any claim about them |

## Manual steps required before this can be deployed

1. Set in **Vercel**: `RESEND_API_KEY`, `FROM_EMAIL`, `EMAIL_SHARED_SECRET`, optional
   `EMAIL_ALLOWED_ORIGINS` (add any custom domain — only `magnet-op.vercel.app` and
   `VERCEL_URL` are allow-listed by default).
2. Set in **Supabase Edge Functions**: `INITIAL_OWNER_SETUP_SECRET`, and the *same*
   `EMAIL_SHARED_SECRET`. ⚠️ If the Edge Function has no `RESEND_API_KEY` it falls back to
   `/api/send-email`, which now **requires** that shared secret — without it, forgot-password
   and verification mail silently stops.
3. ⚠️ **Break-glass warning:** with the local fallback removed, an Edge Function outage means
   *nobody can sign in*. Keep a tested rollback (previous deployment) available.
4. Rotate the Vercel token and the Resend key that were pasted into chat.

> Do **not** run arbitrary `ALTER TYPE app_role` SQL: this repository contains no
> `app_role` schema or migration proving that such a type exists. Any role migration must
> start with an exported schema and a tested, reversible migration.

## Known gaps deliberately left open

- **Business data still uses the Supabase anon key in the browser.** That is not user-level
  isolation. The proper long-term fix is a scoped migration to Supabase Auth plus per-role,
  per-row RLS; do not remove the existing access path until the migration has been tested.
- Compensation data must be separated into a finance-restricted collection before enforcing
  a finance-only policy on the general employee directory.
