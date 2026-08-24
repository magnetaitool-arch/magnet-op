# Magnet OS database strategy

## Current production-compatible model

The known model is a single `public.records` table containing over 50 logical collections in JSONB. Relationships are text keys inside payloads. Migrations `001`–`004` add audit/backup/sync helpers; `005`–`008` are production incident repairs. Exact live grants, policies, extensions, functions, Auth users, and applied migrations are not verified because project-admin access was unavailable during the audit.

The public production probe proves anonymous private-data access remains active. Treat `records` as a legacy compatibility store, not the target domain model.

## Target foundation

| Table | Purpose | Core constraints |
|---|---|---|
| `organizations` | Agency tenant | unique normalized slug; explicit status/timezone/locale |
| `profiles` | Application person linked to identity | PK/FK to `auth.users.id`; explicit status; normalized email diagnostic |
| `organization_members` | User membership in agency | unique `(organization_id,user_id)`; FKs; status; role FK |
| `roles` | Organization/system role | unique `(organization_id,key)` or protected system key |
| `capabilities` | Stable permission vocabulary | unique key |
| `role_capabilities` | Role authorization | unique pair; FKs |
| `organization_invitations` | Secure invite lifecycle | hashed unique token; email/org/role/expiry/state checks |
| `auth_events` | Safe auth diagnostics | append-focused; no secrets |
| `audit_events` | Sensitive change trail | append-only; actor/org/entity/action/request IDs |
| `idempotency_keys` | Command replay protection | unique actor/org/operation/key; stored result/fingerprint |
| `outbox_messages` / `jobs` | Durable async work | explicit state, attempt, lease, next-attempt fields |

Every normalized business row has a direct `organization_id` when practical. Children that derive organization ownership through a parent still need enforceable joins and consistent RLS; denormalizing `organization_id` for policy/performance is acceptable when protected by constraints/triggers.

## RLS model

- `anon`: no private table/view reads or mutations. Public intake is through a rate-limited server endpoint.
- `authenticated`: row access requires active membership in the row's organization.
- Capability-restricted domains add a capability check, especially HR, payroll, bank/national-ID data, finance, and platform control plane.
- Platform admins use audited server routes; they are not a magic RLS bypass in normal browser sessions.
- Views exposed through the API use `security_invoker=true` where available and explicit grants.
- Service role remains server-only and is never used to implement ordinary user authorization.

RLS performance requires indexes beginning with `organization_id` and helper functions that avoid per-row repeated work. Policies must be tested for `SELECT`, `INSERT`, `UPDATE` (`USING` and `WITH CHECK`), and `DELETE`.

## Integrity rules

- UUID primary keys for normalized entities; stable legacy mappings retained separately.
- Intentional foreign-key delete behavior: default `RESTRICT`, owned ephemeral children may `CASCADE`, business/audit history is soft-deleted or archived.
- Organization-scoped unique keys.
- Explicit state enums/check constraints and transition functions for critical workflows.
- Server timestamps and integer revision/version for compare-and-set updates.
- Money stored as integer minor units plus currency, not floating point.
- Normalized email as trimmed lowercase for logical uniqueness/diagnostics.
- Audit/outbox writes in the same transaction as business transitions.

## Migration workflow

Before every schema change document existing schema, problem, proposed schema, migration, rollback, and risk. Use Supabase CLI-generated forward migrations. Applied migrations are immutable.

Recommended sequence:

1. Full schema/data backup and staging restore.
2. Add new tables/nullable mapping columns.
3. Dry-run anomaly report.
4. Backfill in bounded, idempotent batches with stored counts/checksums.
5. Add constraints as `NOT VALID` where useful; validate later.
6. Add indexes concurrently when production size/locking requires it.
7. Dual-read/write with mismatch monitoring.
8. Enable restrictive RLS only after JWT path is verified.
9. Cut over per domain; retain legacy rows during stabilization.

## Concurrency and transactions

- Commands carry idempotency keys and payload fingerprints.
- Multi-row transitions lock the relevant aggregate row or use an atomic RPC/transaction.
- Updates include expected revision; stale revisions return a conflict.
- Rate limiting uses atomic increments/leases, not read-then-upsert.
- Worker jobs use `FOR UPDATE SKIP LOCKED` or a managed durable queue and explicit leases.
- Webhook events have provider event ID uniqueness and replay-safe processing.

## Index strategy

Expected access patterns drive composite/partial indexes, commonly:

- `(organization_id, status, updated_at desc)` for active queues.
- `(organization_id, client_id, created_at desc)` for Client HQ timelines.
- `(organization_id, assignee_user_id, due_at)` for open tasks.
- Partial indexes on non-deleted/active rows.
- Unique normalized email/slug/membership/invite token indexes.

Use `EXPLAIN (ANALYZE, BUFFERS)` on staging-size data. Remove redundant indexes only after usage evidence and rollback planning.

## Legacy-data diagnostics required before backfill

- Duplicate normalized account emails/usernames.
- Account ↔ employee ↔ Auth identity mismatches.
- Orphan client/project/task/deliverable references.
- Unknown role/status values.
- Missing required dates/owners.
- IDs shared across logical collections.
- Tombstone/live conflicts and stale client revisions.
- Rows with no deterministic organization owner.

Diagnostics report before repair. Repairs archive originals, are deterministic/idempotent, and never broadly delete by email/name.
