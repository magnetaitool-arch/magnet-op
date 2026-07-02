# Magnet OS — Data Model

## Storage shape

Everything is stored in a **single Supabase table** `public.records`, one row per
record:

| column | type | notes |
|---|---|---|
| `id` | text (PK) | app-generated, e.g. `cli-<uuid>` |
| `coll` | text | collection name (see below) |
| `data` | jsonb | the full record object |
| `updated_at` | timestamptz | auto-updated by trigger |
| `created_at`,`created_by`,`updated_by`,`deleted_at` | added by migration `004` | derived from `data`; nullable |

The browser mirrors this into `localStorage` (`tia_agency_os_v2`) grouped by `coll`.
The record's own audit fields live **inside `data`**: `createdAt`, `updatedAt`,
`createdBy`, and a `_del:true` tombstone for soft deletes.

## Collections (the `coll` values)

Defined by `COLLECTIONS` in `index.html`:

**Sales / CRM:** `leads`, `clients`, `contacts`, `salesActivities`, `proposals`,
`quotations`, `contracts`, `campaigns`, `briefs`, `plans`, `renewals`
**Delivery:** `projects`, `tasks`, `deliverables`, `revisions`, `contentCalendar`,
`clientAssets`, `approvalRequests`, `meetings`, `services`, `packages`
**Finance (SENSITIVE):** `invoices`, `payments`, `expenses`, `fixedCosts`,
`partnerSettlements`, `employeePayments`
**HR / People (SENSITIVE):** `employees`, `freelancers`, `departments`, `teams`,
`teamRequests`, `attendance`, `leaves`, `performanceReviews`, `candidates`
**System:** `files`, `comments`, `activityLogs`, `notifications`, `reports`,
`automations`, `agentRuns`, `workflows`, `chatMessages`, `gameScores`, `gameStats`,
`collections`
**Accounts (MOST SENSITIVE):** `_accounts` — user records incl. `passwordHash`.

## Important fields by collection (representative)

- `clients`: `id, name, brand, status, ownerId, assignedTo, createdAt, updatedAt`
- `projects`: `id, clientId, name, status, deadline, assignedTo, updatedAt`
- `tasks`: `id, projectId, title, status, assignedTo, dueDate, updatedAt`
- `invoices`: `id, clientId, amount, currency, status, dueDate` — **financial**
- `payments`: `id, invoiceId, amount, method, confirmedBy` — **financial**
- `employees`: `id, fullName, salary, currency, role, email, phone` — **salary = sensitive**
- `candidates`: `id, fullName, email, mobile, expectedSalary, cvLink, gameScore` — **PII**
- `_accounts`: `id, fullName, username, email, role, status, passwordHash,
  isDefaultPassword, assignedClients, dataScope` — **passwordHash must never reach the browser**

## Sensitive fields (never expose publicly)
`_accounts.passwordHash`, `_accounts.verifyToken`, employee `salary`, all `payments`
/`invoices`/`employeePayments`/`partnerSettlements` amounts, candidate PII
(`email`, `mobile`, `expectedSalary`, `cvLink`).

## Owner / user fields
`ownerId`, `assignedTo`, `assignedClients`, `createdBy`, `dataScope` (`all` vs
scoped). These drive role-based visibility in the app and are the join keys for a
future Supabase-Auth RLS (Stage B).

## Sync metadata
- Per-record: `updatedAt`, `createdAt` in `data` (used for last-write-wins merge),
  `_del` tombstone.
- Table columns (migration `004`): `updated_at`, `created_at`, `created_by`,
  `updated_by`, `deleted_at`.
- Recommended additions for a durable queue (see `SYNC_ENGINE_REPORT.md`):
  `localUpdatedAt`, `deviceId`, `userId`, `syncVersion`.

## Soft-delete rules
Deletes are **tombstoned**, not physically removed by the app's merge logic (`_del:true`
records are dropped from views but kept so the delete propagates and never
resurrects). Migration `004` stamps `deleted_at` from `data._del`. Physical deletes
happen only via explicit `cloudDelete`; the **restore tool never deletes**.

## Backup / restore behavior
- Cloud: `tools/backup-supabase-records.js` → checksummed JSON in `/backups`.
- Local: Backup Center export / `tools/backup-local-data.js`.
- Restore: dry-run by default, upsert-by-id, conflict-aware, never deletes.
- In-DB restore point: `records_backup_001` (migration `001`).
See `BACKUP_AND_RESTORE.md`.

## Public-form safety

| Public forms MAY write | Public forms MUST NEVER touch |
|---|---|
| `candidates` (hiring form) | `_accounts`, `invoices`, `payments`, `employees`, |
| `leads` (client inquiry) | `expenses`, `salaries`, `partnerSettlements`, everything else |
| (+ a `notifications` alert row) | |

Enforced in `api/intake.js` / `netlify/functions/intake.js` by an `ALLOWED`
whitelist + per-type field whitelist + honeypot. `_accounts` is additionally blocked
from anon at the DB layer by migration `002`.
