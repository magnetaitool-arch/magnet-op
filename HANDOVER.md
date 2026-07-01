# Magnet OS — Handover / Continue in a new chat

## What this is
**Magnet OS** — a single-file agency CRM/operating system for "Magnet".
- Whole app lives in **`index.html`** (React via htm/babel, no build step).
- Public website forms helper: `netlify/functions/intake.js` (+ `send-email.js`).
- **Live:** https://magnet-op.vercel.app  · login **owner / admin123**
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
