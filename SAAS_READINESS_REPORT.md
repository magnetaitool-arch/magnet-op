# Magnet OS — SaaS Readiness & Release Report

Date: 2026-08-03
Release branch: `codex/saas-readiness-foundation`

## Executive decision

The current release is suitable for a **controlled private production rollout for Magnet's own team** after the deployment gates below pass. It is **not yet safe to sell as a public multi-tenant SaaS**: business records are still accessed from the browser with the shared Supabase anon key, so there is no database-enforced tenant or user isolation for clients, finance, payroll, and employee PII.

## Completed in this release

### Dates and auditability

- Every generic data table now shows `Updated / آخر تحديث` when a record carries audit timestamps.
- Every edit form shows its Created and Last updated metadata.
- Added or enforced operational dates for sales activity, proposals, quotations, invoices, expenses, fixed costs, attendance, meetings, task deadlines, project deadlines, and renewals.
- Proposal/quotation previews and printable documents use their business issue date, with `createdAt` only as a legacy fallback.
- Status transitions stamp business milestones automatically: task completion, project completion, deliverable approval/delivery, and invoice payment.
- Employee lists now show join date and last update.

### Attendance and payroll

- Work start/end, late grace, weekends, and holidays are configurable.
- Attendance calculation and payroll lateness use the same rules.
- Manual attendance is available directly from each employee profile/list.
- A second attendance row for the same employee/date is blocked; the existing row must be edited.
- Payroll rows can be created, edited, deleted by an authorized role, printed, emailed, sent by WhatsApp, and explicitly marked paid.
- **Sending a payslip no longer marks salary as paid.** Payment and email delivery are separate states.

### Employee reports

- Manual report from Employees or Reports.
- Automatic monthly draft per active employee for the previous month.
- Draft review, editing, approval, deletion, PDF/print, and email.
- Metrics use tasks, attendance, leave, performance reviews, and optionally salary (permission-gated).
- Report email now records provider ID, recipient, accepted time, error, and delivery state.

### Task completion and assignment

- Assigned employees can mark their own tasks Done; managers retain full edit/delete rights.
- New assignment and reassignment create an in-app notification, activity log, webhook, and (when email notifications are enabled) a tracked email.
- Managers can manually Send/Retry and Check delivery from Task details.
- Email states are distinct: `Not sent`, `Disabled`, `Missing email`, `Sending`, `Accepted`, `Delivered`, `Delayed`, `Opened`, `Clicked`, `Bounced`, `Complained`, `Failed`.

### Email reliability

- Vercel and Netlify endpoints validate payloads and idempotency keys.
- Resend idempotency protects automatic assignment emails from duplicate sends.
- The UI can query the provider for the latest delivery event.
- Settings includes an email configuration health check and a clear warning when the app is still using the Resend test sender.
- `onboarding@resend.dev` is treated as test mode. A verified company domain and `FROM_EMAIL` are required before emailing arbitrary staff addresses.

## Verification performed

| Check | Result |
|---|---:|
| Offline app/server smoke tests | 34 passed, 0 failed |
| Email endpoint behavior/security tests | 24 passed, 0 failed |
| Static security verifier | 26 passed, 0 failed, 1 expected CSP warning |
| Git whitespace validation | passed |
| Live config probe | 0 failures, 2 local-secret warnings |
| `_accounts` anonymous exposure | blocked by live RLS |
| Pre-deploy business-data backup | 1,443 records / 43 collections, checksum validated |
| Browser test of local `127.0.0.1` | blocked by browser URL policy; must be repeated on the HTTPS deployment |

The backup excludes `_accounts` because no service-role key is stored locally; account hashes remain protected by RLS. A full break-glass backup still requires the service-role key. The CSP warning exists because the app still runs a single inline Babel/HTM bundle. It should be removed during the modular build migration.

## Production deployment gates

Do not call the release complete until all gates are green:

1. Back up the live Supabase records with a service-role key and validate the backup.
2. Set/verify Vercel variables: `RESEND_API_KEY`, verified-domain `FROM_EMAIL`, `EMAIL_SHARED_SECRET`, and any custom `EMAIL_ALLOWED_ORIGINS`.
3. Set the matching email/shared secrets on the Supabase accounts Edge Function; verify forgot-password end to end.
4. Deploy this branch and test on HTTPS in English and Arabic at desktop and 375px mobile widths.
5. Test one account for every live role: Owner, Manager/PM, HR, Finance/Accountant, Sales, Creative, and Client.
6. Test: task assign email, task Done, attendance edit, duplicate attendance rejection, payroll email Accepted then Delivered, explicit Mark paid, report automatic draft, manual report, report edit/delete/send.
7. Confirm no `Bounced`, `Complained`, or `Failed` rows remain in Settings email diagnostics.
8. Keep the previous Vercel deployment available for rollback.

## Why this is not public SaaS yet

### P0 — database isolation (mandatory before selling)

- Introduce `workspace_id` on every business record.
- Replace shared anonymous business-data access with Supabase Auth JWTs.
- Enforce tenant, membership, and role restrictions in RLS—not only in the browser UI.
- Move salary, bank account, national ID, payroll, and sensitive HR data into finance/HR-restricted collections or tables.
- Add an immutable server-side audit log for sensitive reads/writes.

### P1 — SaaS platform foundation

- Workspace onboarding, invitations, ownership transfer, suspension, and deletion lifecycle.
- Subscription/billing plans, trial, entitlement enforcement, invoices, failed-payment handling, and cancellation.
- Transactional email domain, webhooks for delivery/bounce/complaint, suppression list, and retry queue.
- Background jobs for monthly reports, reminders, renewals, overdue work, and backups. Current browser-session automation is not sufficient for guaranteed scheduling.
- Central error monitoring, product analytics, uptime checks, and alerting.
- Tested disaster recovery with retention and restore objectives.

### P2 — maintainability and scale

- Move the 1.1 MB single-file React/Babel app into a compiled TypeScript application with modules and route-level loading.
- Replace inline scripts/styles so CSP can remove `unsafe-inline`.
- Add unit, integration, E2E, accessibility, RTL visual-regression, and permission-matrix tests in CI.
- Add API versioning, schema migrations, rate limits, pagination, search indexes, and conflict-resolution UI.
- Complete Arabic copy consistency and accessibility (document `lang`/`dir`, keyboard navigation, labels, contrast).

## Recommended rollout

1. **Now:** private production beta for Magnet staff only, after all deployment gates pass.
2. **Next:** Stage-B Auth/RLS + sensitive-data split; run a two-week internal pilot.
3. **Then:** single external design partner in an isolated workspace.
4. **Public SaaS:** only after billing, tenant isolation, background jobs, monitoring, backups, and legal/privacy controls are proven.

## Release acceptance standard

The release is accepted only when automated tests remain green, HTTPS browser QA is green, real employee-domain emails reach `Delivered`, each role sees only its allowed data/actions, and a tested rollback/backup exists. Provider `Accepted` alone is not proof of inbox delivery, and an emailed payslip is never proof of payment.
