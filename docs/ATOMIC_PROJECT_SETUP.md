# Atomic project setup

2026-09-26. Local implementation; no production migration or deployment.

The existing new-project path first added a local project, then independently wrote an unassigned task template and optional invoice. It neither awaited those writes nor rolled back partial results. The new `create_project_setup_v2` command commits the project, explicitly assigned/due-dated template tasks, optional draft invoice, audit and request ledger in one transaction. Existing projects and their data are not rewritten.

The 11 existing Magnet task templates are preserved in a server catalog. Unknown templates do not silently fall back to social media work. The caller explicitly selects a template owner; every initial task uses the chosen project dates and owner. Unresolved, ambiguous, inactive or cross-tenant employees fail closed. New projects start in preparation states. The invoice remains Draft, uses the explicitly supplied currency/budget and requires fresh `finance.manage` permission. Client and employee relationships are revalidated server-side. Role/tenant claims and unknown fields in the payload are rejected. No email delivery or execution completion is implied.

The existing project form now awaits this command and installs only returned committed rows. Retries reuse a request ID; conflicting payloads and revoked permission are rejected. The former local task-template writer and separate project invoice branch were removed. The shared form awaits asynchronous saves, keeps errors visible, disables submission while pending, and uses accessible wizard buttons. Arabic options/labels are translated while stored enum values remain unchanged; the active step scrolls into view on narrow screens.

## Verification

- 42 ordered migrations pass on isolated PostgreSQL 17.
- Real SQL tests create a project, 10 assigned tasks and one draft invoice atomically, exercise retry/audit deduplication, reject invalid relationships/options/role claims and verify complete rollback when invoice insertion fails.
- Two committed connections using one request ID create one project. The project and ledger survive database restart. Representative existing rows/relationships remain unchanged during the harness rollback/reapply check.
- The actual existing RecordForm connected to the isolated SQL adapter saved a project with 10 tasks in English and Arabic. A real finance-permission denial remained inline with the form intact and no success state. Desktop and Arabic mobile were inspected; mobile had no page overflow and no new browser errors.

## Remaining scope

This fixes new-project transaction safety. Project editing/status changes, canonical project projections/foreign-key chains, dependencies and recurrence still need implementation and verification. Immutable project brief snapshots and verified task/project references are now covered separately in PROJECT_BRIEF_RELATIONSHIPS.md. Legacy generic project mutation paths are not certified by this increment. The configured legacy new-project webhook is still best-effort after commit; durable webhook delivery is a separate remaining integration task.

Migration: `20260925215339_atomic_project_setup.sql`. Rollback application entry point if necessary; retain committed project/task/invoice/ledger/audit data. Hosted staging credentials, backup restoration and production representative reconciliation remain release blockers. Do not ship this RPC-dependent form before the compatible additive migration is live.
