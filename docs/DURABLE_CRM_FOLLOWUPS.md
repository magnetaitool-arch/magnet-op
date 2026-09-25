# Durable CRM follow-ups

2026-09-26. Implemented and verified on isolated PostgreSQL; not deployed.

## Compatibility and migration

Current implementation: legacy `salesActivities` records contain optional lead/owner/date/status/outcome fields and free-text notes. Current data is retained verbatim. Intended behavior: a responsible person has a dated action, records its outcome, and optionally creates the next action as one transaction. Legacy dates and employee identifiers are not sufficiently unambiguous for automatic conversion.

V2 adds `crm_followups_v2` linked to the existing canonical lead and organization membership, plus an internal idempotency ledger. The migration is additive; no existing rows, projections or historical activities are rewritten. The lead profile retains its Activities tab and adds Follow-ups. No legacy data is safe to deprecate yet. Any future import needs explicit owner/date mappings, source IDs and before/after reconciliation.

Migration: `20260925205432_durable_crm_followups.sql`. Requires the existing identity, CRM, notification and audit schemas. Apply to independent staging first. The application release requires this migration; an unupgraded environment displays an unavailable state instead of false empty/success. Rollback is to disable the reminder flag and revert application files while retaining new tables/rows for recovery; do not drop business rows.

## Behavior

- Explicit active internal owner with CRM read capability; no inference from email/name or the first member.
- UTC due instant plus original IANA timezone. Browser timezone is shown on date entry; queue day boundaries use the requested validated timezone.
- Version-checked OPEN edits; DONE/CANCELLED require an outcome/reason. Closed actions are immutable through this command.
- Completion and optional successor insert, audit and recipient notification commit together. Failed successor validation rolls everything back.
- Command UUID is retained across an unchanged retry; different content with the same UUID is rejected. Fresh authorization is checked before replay. Two concurrent transactions commit one record and one notification.
- The pipeline exposes personal/team queues for today, overdue, upcoming and all open actions, with server counts and pagination. Opening a queue item lands on the lead's Follow-ups tab.
- Direct browser writes and browser execution of the reminder worker are denied. Reads and commands require live capability/tenant checks; all references enforce same-tenant ownership.

## Background reminder adapter

The existing authenticated `POST /api/outbox` drain worker calls `enqueue_due_crm_followups_v2` only when `CRM_FOLLOWUP_REMINDERS_ENABLED=true`. Batches are bounded and locked; notification source keys deduplicate retries. Suspended identities/memberships/organizations and owners without CRM read permission are excluded. A reminder failure is reported explicitly while existing outbox processing still runs. This creates in-app reminders; it does not claim external email delivery.

BLOCKED_EXTERNAL for live reminders: independent staging migration verification; server Supabase service-role configuration; an authenticated scheduler invoking the existing drain endpoint using `OUTBOX_WORKER_SECRET`; enable the flag only afterward. The adapter and failure paths are tested; no scheduler is claimed to be running.

## Verification

- 35 ordered migrations execute on isolated PostgreSQL 17 with synthetic platform fixtures.
- Follow-up tests: anon/direct-write/foreign-tenant/ineligible-owner denial; capability and membership revocation including idempotent replay; stale version; changed idempotency payload; required outcome; atomic next-action failure rollback; concurrent deduplication; due queue; server-only worker and repeated reminder deduplication.
- A committed follow-up survives PostgreSQL restart. Full representative public-row reconciliation across the existing function rollback/reapply preserves values and relationships.
- Actual mobile browser, using the real UI and a loopback adapter to that PostgreSQL instance: create an assigned follow-up, complete with outcome and successor, full reload, reopen Arabic lead profile and verify persisted records. No private production rows or hosted credentials are used. Native datetime input was filled through its DOM setter after the browser automation fill command did not set it.
- Local API fixture is optional via `MAGNET_FOLLOWUPS_BROWSER_QA=1 node tools/database-test.mjs`, binds only loopback and restricts origin, scope and RPC allowlist. It is not in the release inventory.

Screenshots: `docs/audit-assets/2026-09-25/followup-*.png`. Hosted PostgREST/Auth, real multi-device behavior, real historical-data import, and managed production backup/rollback remain separate release gates.
