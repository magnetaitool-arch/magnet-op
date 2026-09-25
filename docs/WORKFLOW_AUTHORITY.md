# Workflow transition authority

2026-09-26. Local implementation and isolated rehearsal; not deployed.

The previous browser-only workflow readiness function used cached rows, treated internally approved offers as client acceptance, allowed a requested asset to complete onboarding, and used loose status expressions. Advancement wrote the workflow and client status separately and immediately showed success. These were not reliable execution gates.

`20260925213431_authoritative_workflow_transitions.sql` adds authenticated start, readiness and advance RPCs. Existing workflow rows/history are preserved. Start serializes with lead conversion and reuses one client workflow; conflicting/deleted workflows require review. Advancement locks the current record, compares expected stage, rechecks live capability and saves workflow history, client lifecycle changes, audit and request ledger atomically. Reused command IDs require matching actor/payload. Direct stage/history or identity changes are rejected. New authenticated records cannot begin at an execution stage. No automatic historical correction is performed.

Readiness is evaluated against tenant-scoped saved records. Commercial acceptance requires an accepted immutable proposal handoff. Contracts require Signed/Active plus recorded signature time. Invoices require an issued valid positive-value projection. Payments must belong to that client's issued invoice and cannot be future dated. Collections are not payment evidence. Onboarding requires the completed checklist. Projects need valid ordered dates and an unambiguous active employee member owner; tasks need due dates and active assignees. Internal/client review and delivered work use explicit states. Draft reports do not satisfy reporting.

The UI loads these checks with separate loading/failure states and translates actionable reasons. Transitions await the database result before installing committed records. Retries preserve request IDs. A stale browser stage is refreshed from the server. Disabled buttons now look disabled. The old cached-readiness implementation was removed.

## Verification

- 40 ordered migrations execute on isolated PostgreSQL 17 with synthetic Supabase Auth/Storage fixtures.
- Real SQL tests cover missing evidence at every stage 3–14, false-positive legacy records, valid contact fallback, completed onboarding, dated active project owner, review/delivery/report transitions, request replay, audit deduplication, stale stage, revoked capability and cross-tenant/anonymous denial.
- The actual workflow component was connected to the loopback SQL adapter. Discovery advanced to proposal; missing acceptance blocked; creating an accepted revision handoff enabled the next transition; missing signed contract blocked further progress. Saved stages were reloaded through the RPC. Browser error history was empty during this sequence. English mobile was visually inspected; Arabic and further layout checks continue.

## Scope and remaining work

These are current-stage operational checks. They do not prove that every historical workflow met every earlier gate. Existing advanced workflows need reconciliation before rollout. Discovery still checks contact/service completeness; canonical structured brief completion is a separate remaining feature. Deliverable approval is still legacy status/event evidence, not yet an immutable asset-version approval. Reporting status is not yet proof of provider-backed metric provenance. No claim is made that those later domain models are complete.

Hosted staging, production representative reconciliation and rollout remain blocked on independent staging credentials and recovery rehearsal. Revert application files and matching CSP for an application rollback; preserve new ledgers/audit/business rows. Do not restore the former insecure direct-transition behavior as a database rollback.

## Shared onboarding checklist

`20260925214704_persistent_onboarding_checklist.sql` preserves the existing client `onboarding` array and exposes read/save commands with tenant capabilities, row locks, expected checklist hash, request identity and an audit event per changed item. Missing/empty lists use the existing five onboarding steps, persisted only by an explicit save. Custom labels and extra fields remain intact. Malformed arrays/booleans are flagged for review. The command ledger prevents retry duplication; conflicting payloads or stale edits are rejected.

Workflow and Accounts now share `modules/client-onboarding.js`; the older optimistic checklist writer was removed. It waits for committed results and exposes loading, retry and conflict states. Actual browser tests checked two items, reloaded and reopened in Arabic; both remained checked. English desktop and Arabic mobile were inspected, with 48px rows, no horizontal overflow and no new browser errors. These are real isolated PostgreSQL saves, not hosted Auth verification. Database tests also cover inactive/cross-tenant/anonymous denial and preservation of ambiguous legacy data. The isolated harness now passes 41 ordered migrations.

Visual testing caught service-worker reuse of an earlier CSS URL. `tools/asset-versions.js` now derives every published local module/stylesheet URL from its file hash. Run `pnpm run assets:update` after those assets change, then `pnpm run csp:update` after inline HTML scripts change. Build rejects mismatched asset hashes. The cache-key regression proves changed CSS gets a new URL while unchanged JS retains its URL; unlisted paths are rejected. No extra production dependency is added.
