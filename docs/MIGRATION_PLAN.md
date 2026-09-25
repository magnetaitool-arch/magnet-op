# Incremental migration plan

## Guardrails and current gate

No replacement application or parallel client database. The legacy shell remains
while domains move behind existing canonical identity and transaction boundaries.
Production data is preserved. Applied migrations are immutable.

Current local access does not include a verified separate staging database or a
fresh complete production backup. Therefore this increment changes application
code/tooling only; it does not create speculative production SQL or run backfills.

## Required sequence for each domain

1. Inspect actual schema, migration ledger, advisors, row counts, RLS, constraints,
   orphan references, object counts/bytes, and auth configuration.
2. Create full service-role backup, including server-only collections and storage
   inventory. Validate checksum and counts; restore to a separate staging project.
3. Record current/target schema, deterministic legacy-to-UUID mapping, conflict
   policy, impact, rollback owner, and bounded backfill batch size.
4. `supabase migration new <domain>`; add nullable structure first. Existing
   `client_accounts`, `profiles`, and `organization_members` are parents.
5. Backfill idempotently with checkpoints and anomaly ledger; quarantine ambiguous
   ownership instead of guessing. Reconcile totals and critical field values.
6. Add/validate composite tenant FKs, unique constraints, revision checks, indexes,
   and RLS. Test anon, authenticated roles, service, and cross-tenant relations.
7. Switch one domain to server commands/queries behind a deployment flag. Keep
   compatibility reads only while measured parity is zero; stop on divergence.
8. Validate browser reload, retry, concurrency, export, notifications, and rollback.
9. Roll out compatible application code only after additive migration is live.
   Keep prior deployment and data paths during the stabilization window.

## Domain order

1. Identity and membership resolution, environment separation, file ownership.
2. Projects/tasks/briefs/assets and revision-bound approvals.
3. Contacts/opportunities/follow-ups/proposal versions and activity-derived score.
4. Structured audits/strategy with provenance to tasks.
5. Studio document/page/block/version persistence on the same client identity.
6. Content/variants/calendar, then social connections and durable publishing.
7. Analytics/reporting, rules/search/notifications, optional AI.

## Rollback and retention

Use application flags/previous deployment first; additive tables and mappings stay
intact. Reverse a backfill only using its documented mapping and archived originals,
never broad delete-by-name/email. Retain audit/outbox/idempotency evidence. Pause
workers before reverting their schema-dependent consumers. Do not enable restrictive
policies before the verified JWT path exists. Roll back on login/member resolution
failure, RLS-denial spikes, orphan growth, or count/critical-value mismatch.

The current auth-entry/runtime-config increment has no data migration. Its rollback
is the prior application artifact; it does not alter server identity or RLS.
