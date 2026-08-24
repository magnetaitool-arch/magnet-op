# MAGNET OS V2 UX implementation backlog

Status: BACKLOG ONLY — frozen until security foundations are safe

This backlog preserves the requested product and UX scope without starting a UI
rewrite during M0/M1. The MAGNET identity remains the design source of truth.

## Global interaction rules

- [ ] Clicking a record opens its detail/profile/workspace.
- [ ] Edit is a separate explicit action and is never required merely to read.
- [ ] Replace giant vertical card stacks with tabs, stage navigation, compact
  rows, tables, folders, pagination, virtual lists, drawers, and detail pages.
- [ ] Cards are used only when they improve comprehension.
- [ ] Persistent global search is available in the application header.
- [ ] Notifications deep-link to the exact authorized record.
- [ ] Dates, currency, statuses, loading, empty, error, and validation states are
  consistent in Arabic and English.

## Visual system V2

Preserve:

- Background `#070807`
- Cards `#10110F` / `#151713`
- MAGNET accent `#C8F31E`
- Primary text `#F5F5F2`

Add restrained semantic tokens:

- [ ] Success — green
- [ ] Danger/overdue/error — red
- [ ] Warning — amber
- [ ] Info — blue
- [ ] Draft/neutral — neutral
- [ ] Primary actions/highlights — MAGNET lime

Avoid generic SaaS styling, excessive gradients, excessive borders, rainbow
status palettes, and visual clutter.

## Responsive/platform quality

- [ ] Purpose-built layouts at 390, 430, 768, 1024, 1280, 1440, and 1920px.
- [ ] No horizontal overflow.
- [ ] Mobile uses bottom sheets/drawers and mobile-specific tables/actions rather
  than a shrunken desktop.
- [ ] Test Chrome macOS, Safari macOS, Chrome Windows, Edge Windows, Safari iOS,
  and Chrome Android.
- [ ] Verify fonts, scroll, inputs, native date controls, modals, tables, file
  upload, print, RTL, and LTR.

## Recruitment V2 — M5

- [ ] Stage navigation: New, Screening, Interview, Offer, Hired, Rejected,
  Archived.
- [ ] Each stage shows a live count.
- [ ] Compact List View and Card View.
- [ ] Search, filter, sort, and pagination/controlled infinite loading.
- [ ] No hundreds of large applicant cards in one page.
- [ ] Website submission creates a canonical Applicant with source Website.
- [ ] Submission validation, bot protection, rate limit, and idempotency.
- [ ] Activity event and reliable email/WhatsApp notification.
- [ ] Recruitment destination is provided through server environment
  configuration, never hardcoded in Git.
- [ ] Secure deep link opens the applicant, not a public predictable URL.

Applicant profile:

- [ ] Header: name, position, status, phone, email, application date.
- [ ] Tabs/sections: Overview, Application Answers, CV, Portfolio, Experience,
  Salary Expectation, Interview, Internal Notes, Attachments, Timeline.
- [ ] Actions: Open Profile, Move Stage, Schedule Interview, Add Interview Notes,
  Shortlist, Reject, Hire, Contact Applicant.
- [ ] Edit modifies data only.

Employee lifecycle connection:

- [ ] Applicant → Screening → Interview → Offer → Hired → Employee → Account →
  Team → Tasks → Attendance → Payroll → Documents.

## Website-to-sales automation — M6

- [ ] Valid website sales/contact submissions create canonical CRM Leads.
- [ ] Email and WhatsApp notifications contain name, company, phone, requested
  service, message, and submission time.
- [ ] Sales destination is server environment configuration, not a repository
  constant.
- [ ] Secure deep link opens the Lead in MAGNET OS.
- [ ] Rate limiting, bot protection, validation, and idempotency.

## Client Workspace V2 — M6

- [ ] Client header: name, status, account manager, current balance, active
  contract, project status.
- [ ] Tabs: Overview, Contacts, Projects, Tasks, Contracts, Invoices, Payments,
  Files, Communication, Reports, Activity.
- [ ] Client workspace becomes the single source of truth.
- [ ] Canonical relationship: Client → Contacts → Projects → Contracts → Invoices
  → Payments → Tasks → Files → Communication → Reports → Timeline.

## Finance/accounting V2 — M7

- [ ] Finance dashboard summary: Revenue, Collected, Outstanding, Overdue,
  Expenses, Net.
- [ ] Tabs: Invoices, Payments, Expenses, Payroll, Contracts.
- [ ] Tables, search, filters, date range, client/status filter, and export.
- [ ] Semantic status colors.
- [ ] Client → Contract → Invoice → Payment relation is visible throughout.

Invoice detail/form:

- [ ] Invoice number, client, contract/project, issue date, due date, currency,
  subtotal, tax, discount, total, paid amount, remaining amount, status.
- [ ] Statuses: Draft, Issued, Partially Paid, Paid, Overdue, Cancelled.
- [ ] Invoice must belong to a client and appropriate contract/project.

Payment detail/form:

- [ ] Payment number, client, invoice, amount, method, date, reference,
  attachment, created by.
- [ ] Payment cannot exist as a loose record.
- [ ] Calculate total invoiced, total paid, outstanding, and overdue.
- [ ] Client financial profile shows contracts, invoices, payments, outstanding,
  and revenue history.

## Contract Management — M8

- [ ] Contract belongs to a client.
- [ ] Lifecycle: Draft, Internal Review, Ready, Sent, Signed, Active, Expired,
  Cancelled.
- [ ] Create, edit draft, preview, duplicate, download PDF, print, send, archive.
- [ ] Master Contract Template system with service-specific templates: Social
  Media, Performance Marketing, Website Development, Branding, Production,
  Retainer, One-time Project.
- [ ] Dynamic legal/client/scope/platform/deliverable/date/value/currency/payment/
  advertising-budget/additional-condition fields.
- [ ] Sections: Parties, Definitions, Scope, KPIs, Duration, Value, Payment,
  Late Payment, Agency/Client Obligations, Working Hours, Out-of-Scope,
  Exclusions, IP, Confidentiality, Portfolio Rights, Liability, Force Majeure,
  Official Communications, General Terms, Governing Law, Signatures.
- [ ] Output follows the professional MAGNET contract identity.
- [ ] Secure client-portal review/download/print/accept/sign architecture.
- [ ] Expiring signed access links; no predictable public URLs.

## Documents, storage, scanning, and print — M9

- [ ] Secure object storage for employee documents, CVs, IDs, contracts,
  invoices, receipts, scans, client files, and company documents.
- [ ] File bytes never live in localStorage, business JSONB, or frontend bundles.
- [ ] Database stores metadata and secure object references.
- [ ] Upload File, Scan Document, Upload Invoice, Upload Receipt, Upload Employee
  Document actions.
- [ ] Metadata: type, owner, client/employee, date, reference, tags, notes.
- [ ] Preview, download, print, rename, move, archive, permissioned delete.
- [ ] Images: intelligent resize/compression, readable quality, thumbnail, safe
  efficient formats.
- [ ] Scans: optimized PDF where appropriate without destroying text clarity.
- [ ] Preserve original where required plus optimized version and thumbnail.
- [ ] Avoid repeated original downloads.

Print system:

- [ ] Contracts, invoices, receipts, permitted employee documents, reports, and
  proposals.
- [ ] Hide navigation/actions, preserve Arabic/RTL, use clean A4 output, and
  produce print-ready PDF.

## Tasks V2 — M10

- [ ] Navigation: My Tasks, Today, Upcoming, Overdue, Completed, All.
- [ ] List and Board views.
- [ ] Filters: client, project, assignee, team, priority, status, date.
- [ ] Pagination or virtualization.
- [ ] Task drawer/detail: title, description, client, project, assignee, deadline,
  priority, status, attachments, comments, activity.
- [ ] Clear, authorized Done action and explicit transition feedback.

## Global search — M11

- [ ] Search clients, leads, employees, applicants, tasks, projects, contracts,
  invoices, payments, files, and reports.
- [ ] Match names, companies, phones, emails, document/invoice/contract/payment
  references, task titles, and document references.
- [ ] Categorized result counts.
- [ ] Filters: type, date, client, employee, amount, status.
- [ ] Server-side, tenant-scoped, capability-aware results only.
- [ ] Unauthorized result existence is not leaked through count or snippets.

## Notifications and activity — M13

- [ ] Categories: Tasks, Approvals, HR, Finance, Clients, Contracts, Sales,
  System.
- [ ] Deep-link to the exact record.
- [ ] Reliable unread counts and delivery/read state.
- [ ] Important entities show activity timelines.
- [ ] Log actor, action, timestamp, entity, and safe before/after summary.
- [ ] Sensitive events are immutable.

## System health and observability — M13

- [ ] Admin health screen: Database, Storage, Email, WhatsApp, Authentication,
  Jobs, deployment version.
- [ ] Structured logs and correlation IDs.
- [ ] Auth, API, email, WhatsApp, job, and security event views without secrets.
- [ ] Clear degraded/outage state and owned alerts.

## Performance/offline quality — M13

- [ ] Stop full-database browser downloads.
- [ ] Scoped server queries, pagination, indexes, lazy loading, permission-aware
  caching, and server filtering.
- [ ] Gradually split the monolith without a big-bang rewrite.
- [ ] Optimistic concurrency/version control.
- [ ] Stale clients receive a conflict instead of overwriting newer data.

## Email and WhatsApp UX — M4

- [ ] Outbox status: queued, processing, delivered, failed, suppressed,
  cancelled.
- [ ] Retry/resend action and useful failure category.
- [ ] Provider delivery state, correlation ID, and timestamps.
- [ ] WhatsApp supports recruitment, sales, OTP, and operational alerts through a
  replaceable server provider.
- [ ] No provider credentials or message secrets in browser code.

## Release and QA — M14

- [ ] Development → automated tests → staging → migration validation → security
  tests → responsive tests → production.
- [ ] Checkpoint after every major milestone.
- [ ] Login, logout, reset, OTP, deactivation, role changes.
- [ ] Client CRUD and client workspace.
- [ ] Applicant, recruitment form, and sales form.
- [ ] Invoice creation, payment entry, and contract generation.
- [ ] File upload/compression, search, permissions, and printing.
- [ ] Arabic/English, mobile/desktop, and platform/browser matrix.
- [ ] Before/after/orphan/conflict counts for every data migration.
- [ ] No silent deletion of existing clients, employees, tasks, finance,
  applications, contracts, or other business records.
