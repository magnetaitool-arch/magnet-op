# Magnet OS — Handbook & Playbook

The operating system for the Magnet agency: CRM, projects, finance, HR,
collections, gamification, and public client/candidate forms — all in one place.

- **Live:** https://magnet-op.vercel.app
- **First login:** create the Owner account in the secure first-install screen; there is no default username or password.
- **Languages:** English (Finance/HR screens) + Arabic (client brief page). Toggle with the **ع/EN** button in the top bar.
- **Theme:** Light/Dark toggle (moon/sun) in the top bar.

---

## 1. Quick start (first 5 minutes)
1. Open the live URL and sign in.
2. Top bar (right→left): **background music**, **alert sound**, **notifications 🔔**, **language**, **theme**, **role tester** (Owner only), **your profile**.
3. Left sidebar = your modules, grouped (Main, Operations, Sales, Finance, Team/HR, Workspace, Fun, System). You only see modules your role allows.
4. Open **Profile** (top-right avatar) → change your password.
5. Owners: go to **Settings → Modules** to turn modules on/off (Focused vs. Show-everything).

---

## 2. Core concepts
- **Everything is a record.** Each item (client, task, invoice, collection…) is a record you create/edit through a form.
- **Brands:** data is tagged Magnet / Spark; filter with the brand switch at the top.
- **Permissions are per role** (see §3) and can be fine-tuned per employee (Hidden/View/Edit) in **Users & Permissions**.
- **Cloud sync:** all devices share the same live data (Supabase). Changes appear on other devices within seconds.
- **Currency:** default **EGP**. Set per record where relevant.

---

## 3. Roles & permissions
Assign a role to each employee in **Employees → (employee) → Access → App role**. The role decides which modules they see and edit.

**Positions available:** Owner, Admin, Manager, HR, Marketing Director, Art Director, Account Manager, Sales, Social Media Specialist, Content Creator, Graphic Designer, Reel Creator, Video Editor, Finance, Client.

Quick guide (✏️ edit · 👁️ view · 🚫 hidden). Owner/Admin = full edit everywhere.

| Position | Sees / does |
|---|---|
| **Owner / Admin** | Everything, incl. Users, Roles, Backups, Settings. |
| **Manager** | Projects, tasks, clients, plans, all HR, views invoices/collections. |
| **HR** | Employees, attendance, leaves, recruitment, departments, requests. People only — no finance/projects. |
| **Marketing Director** | Campaigns, content calendar, briefs, leads/proposals, reports, clients. |
| **Art Director** | Tasks, deliverables, content calendar, client assets, revisions, approvals. Leads creatives. |
| **Account Manager / Sales** | Leads, campaigns, briefs, proposals, quotations, contacts, clients. |
| **Social Media Specialist** | Creative work + content calendar + campaigns + briefs. |
| **Content Creator / Graphic Designer** | Tasks, deliverables, files, content calendar, client assets, comments. |
| **Reel Creator / Video Editor** | Same creative set (video/montage focus). |
| **Finance (Accountant)** | Invoices, payments, **collections**, expenses, fixed costs, partners, profitability. |
| **Client** | Portal: own projects, deliverables, invoices, files. Comment/chat only. |

> Fine-tune any single employee in **Users & Permissions** — override any module to Hidden / View / Edit.

---

## 4. Module map
**Main:** Dashboard · Plans & Goals · CRM/Leads · Clients · Projects · Tasks · Deliverables
**Operations:** Requests · Approval Center · Client Assets · Content Calendar · (Meetings, Chat, Share Center, Workflow — optional)
**Sales:** Campaigns · Client Briefs · (Contacts, Sales Activities, Proposals, Quotations, Contracts, Documents)
**Finance:** Invoices · Payments · **Collections** · Expenses · Fixed Costs · Partners & Settlement · Profitability
**Team/HR:** Recruitment · Teams · Employees · Team Availability · Freelancers · Departments · Workload · Attendance · Leaves
**Workspace:** Files · Comments · Notifications · (SOPs)
**Fun:** Leaderboard · Arcade
**System:** Users & Permissions · Roles & Permissions · Backup Center · Settings

---

## 5. Playbook: Onboard a new client
1. **CRM/Leads** → new lead → move across the pipeline → mark **Won** → **→ Client**.
2. On the client, fill the **Contract** group: service type, **Monthly retainer**, **Billing cycle**, contract start/end, renewal date, **Collection day (1–28)**.
3. Assign **Account manager** + **Project/Primary team**.
4. **Projects** → new project for the client (default tasks auto-generate by project type).
5. **Client Assets** → record brand files & account access (no raw passwords).

## 6. Playbook: Collections (getting paid) 💰
1. On each active retainer client, set **Monthly retainer + Billing cycle + Collection day** (§5).
2. Open **Finance → Collections**. The **"Upcoming from retainers"** panel predicts who to collect from, how much, and when.
3. Click **Generate due** to create the pending collection records for this cycle (or add one manually with **New collection**).
4. When money arrives → **Mark collected**. This records a **Payment** automatically (feeds Profitability & Partners).
5. Watch the KPIs: *Expected this month · Collected this month · Overdue · Due in 7 days*. Finance gets a daily reminder for overdue/soon items.

## 7. Playbook: Invoicing & payments
- **Invoices** → new invoice (items, discount, tax → total is what prints and what the balance uses). Print/Save-as-PDF from the invoice.
- **Payments** → record a payment against an invoice (or auto-created from Collections).
- **Profitability** → revenue (payments) − expenses − monthly fixed costs, per client/project.
- **Partners & Settlement** → 50/50 split (Mohamed Hassan / Mohamed Tarek) with per-item settle + history.
- *Invoices & Payments can never be deleted (financial safety).* 

## 8. Playbook: Employee self-service (Leave / Permission / Lateness)
1. Any employee: **Dashboard** or **Requests** → **"Request time off"** → pick **Leave / Permission / Lateness**, fill dates/reason, choose the approver, send.
2. The manager/HR gets a notification → **Requests → Pending My Approval** → Approve / Reject (with a comment).
3. The employee is notified of the result.
4. On approval: a **Leave** is logged in the HR calendar; a **Lateness** marks today's attendance as *Late*.
- Who can approve time-off: **Admin, Manager, HR, Marketing Director, Art Director**, or the specific approver chosen on the request.

### Employee reports (manual + automatic)

- **Manual:** Employees → open an employee → **New report** → choose month/language, add the manager narrative, save, then use **Reports → Preview / PDF**.
- **Automatic:** on the first eligible Admin/HR login each month, Magnet OS creates one **Draft** for the previous month for every active employee. It calculates attendance, lateness, leave, tasks and performance from stored records.
- Automatic drafts are never emailed automatically. Review, approve, then send from Reports.
- Reports can be edited or deleted after confirmation. A deleted automatic report is suppressed for that employee/month and will not be regenerated.
- Salary/payments are optional and remain protected by the salary permission.

## 9. Playbook: Tasks & delivery
- **Tasks** (Trello board) → drag across stages; assign to a team member.
- **Deliverables** → submit for **Client Review**; client Approves or Requests revision from their portal.
- **Content Calendar** → schedule posts; assignees get notified; "due today" pings the PM.
- **Approval Center / Requests** → route anything needing a sign-off (send-to-client, expense, discount, etc.).

## 10. Playbook: HR & attendance
- **Attendance** auto-logs a check-in when someone signs in. HR can mark Late/Absent/Remote.
- **Payroll summary** = salary ÷ work-days × days present (capped at a full salary).
- **Recruitment (ATS)** → candidates pipeline; hire → convert to an employee.
- **Leaves** → requests + approvals (also fed by the self-service flow in §8).

## 11. Public links (no login needed)
- **Campaign lead form:** `…/?form=SLUG` → creates a Lead + notifies Sales.
- **Client brief (Arabic):** `…/?brief=TOKEN` → fills the client brief.
- **Email verify:** `…/?verify=TOKEN` → activates a new account.

---

## 12. Admin & security
- **Keep the Owner password private** and change it from Profile whenever needed.
- **Accounts are protected server-side:** login and all account changes go through a Supabase **Edge Function** (`accounts`); password hashes never reach the browser, and the public key can no longer read or modify accounts.
- **Users & Permissions** → create logins, set roles, per-module overrides. **Roles & Permissions** → see what each role can do.
- **Backup Center** → export/download JSON snapshots regularly. Supabase also keeps the live data.
- **Password reset:** employees use **Forgot password** (emails a temp password — needs email set up, §13); or an admin resets it in Users & Permissions.

## 13. Email setup (Resend)
- Notifications & forgot-password send via **Resend**. The API key is set on Vercel.
- **Test mode limitation:** the shared sender only delivers to the Resend account owner's email. **To email the whole team**, verify a **domain** in Resend (add DNS records) and set `FROM_EMAIL` to an address on it.

## 14. Deployment & operations (owner/dev)
- Static app on **Vercel** (project `magnet-op`). Data on **Supabase** (`jdylrthffifbhyrrhuqd`).
- Deploy after edits: `vercel deploy --prod --yes --scope magnetaitool-archs-projects --token=YOUR_TOKEN` (needs a token from vercel.com/account/tokens).
- Source of truth = the project zip. Edit `index.html` (single file, React via htm, no build step).
- Env vars (Vercel): `RESEND_API_KEY`, `FROM_EMAIL`. Supabase Edge Function `accounts` handles auth.
- After any deploy: hard-refresh once (the service worker updates itself).

## 15. Troubleshooting / FAQ
- **"I don't see a module."** Your role hides it, or it's disabled in Settings → Modules (Owner can enable).
- **"Data looks old."** Hard-refresh once; the app syncs every few seconds.
- **"Email didn't arrive."** Check spam; if you're not the Resend account owner, the team domain isn't verified yet (§13).
- **"Can't delete an invoice/payment."** By design — financial records are protected.
- **"Login fails."** Check the username/email + password; an admin can reset it in Users & Permissions.
- **Leaderboard scores missing?** They live in the cloud and refresh automatically; hard-refresh if a very recent score isn't showing.

---

### One-line summary
Magnet OS runs the agency end-to-end: **win clients → deliver work → collect money → pay the team → track everyone's performance** — with role-based access, self-service HR requests, automated collections, and server-protected accounts.
