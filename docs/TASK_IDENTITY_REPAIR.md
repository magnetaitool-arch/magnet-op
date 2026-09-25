# Task identity repair — 2026-09-25

Candidate migration: `20260925203306_unambiguous_task_identity.sql`. Local only; not applied to production.

## Defect and reproduction

The original resolver chose an arbitrary confirmed link or profile via LIMIT 1. The assignee predicate accepted the current user's employee mapping even when `assigned_user_id` explicitly identified somebody else. The new PostgreSQL regression failed before the patch (`true !== false`). This is an access-control defect, not merely duplicate UI data.

## Change

Resolve the distinct union of confirmed Auth links and profile employee mappings only when exactly one identity exists. Blank/no/ambiguous mappings resolve to NULL. An explicit task `assigned_user_id` takes precedence; fallback is allowed only when that field is NULL. Existing active-membership, capability and client-visibility checks remain required in callers. Function signatures and grants remain compatible; no business row, legacy link, assignment or audit event is rewritten.

This intentionally denies ambiguous fallback access. It does NOT guess a correct employee, repair previously materialized incorrect `assigned_user_id` values, or grant membership to a resolved user. Existing task assignments must be reconciled with reviewed identity evidence before rollout. A manager retains access through normal capabilities; affected employees require an explicit reviewed assignment.

## Validation

The isolated PostgreSQL 17 harness applies 33 ordered migrations. Tests cover a unique profile mapping, conflicting profiles, a confirmed-link/profile conflict, blank mapping, explicit assignee precedence, RLS row invisibility and task-detail RPC denial. Existing tenant, revoked/suspended user and upload tests remain active. The full representative public row values/relationships are identical across old-function rollback and repair reapply, and persistence survives process restart.

These are synthetic schema/data tests, not a hosted Auth lifecycle or production reconciliation. The authoritative before/after report remains mandatory for a real rollout.

## Staging, rollback and risk

Rehearse with an independent restored staging copy, inventory all task assignment vs employee/Auth conflicts, and require reviewed decisions for ambiguous rows. Compare tenant IDs, row/relationship counts, per-row hashes and recipient mappings. Exercise two users and two tenants through real sessions, including assignment changes and notifications.

Rollback of function definitions is mechanically tested but restores the old vulnerability; prefer forward repair. Never restore old business rows over newer activity. If rollout denies expected access, stop rollout and repair the reviewed mapping rather than reverting authorization blindly. No production application/schema deployment is performed in this audit.
