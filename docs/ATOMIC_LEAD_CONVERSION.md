# Atomic lead conversion — local candidate

Migration `20260925203800_atomic_lead_conversion.sql`, created with the CLI, is append-only and unapplied remotely. It adds one command; it does not backfill or delete data.

## Preserved intent, corrected mechanism

The existing UI converted an already-Won lead to a client in Discovery, then opened the commercial workflow. That intent is preserved. Execution projects/tasks are deliberately not fabricated before an accepted offer, contract and first payment; full opportunity-to-project orchestration remains W2/W3/W4 work.

The new command locks the lead and serializes conversion commands within its explicit organization. It validates fresh membership and clients read/manage capabilities, excludes client-role callers, requires Won, checks the expected lead version, and commits client + workflow + lead link + audit + recipient notifications in one transaction. Retry returns the existing explicitly linked records without advancing workflow or duplicating notifications/audit events. It preserves the current client-scoped workflow when unambiguous.

Ambiguous contact matches, multiple explicit clients/workflows, unavailable/deleted linked records, foreign-tenant links and stale versions fail before completion. Email/phone are review evidence, never identity. Estimated deal value is no longer copied into an agreed monthly retainer. Sales owner is not silently assigned as account manager, missing service is not defaulted to social management, and client health is not invented as Green. Original lead fields remain intact for review.

The browser now sends only organization, lead ID and expected version. It updates its cache from the committed response and keeps the profile open with a clear error on failure. It does not repeat the client/workflow writes. Configured legacy new-client/lead-won webhooks are retained after first confirmed success; they remain best-effort and can still be missed if the response is lost. W10 durable adapter work is not complete. Notifications go to the converting user and active account-manager memberships in the same organization; actor attribution and one source key prevent replay duplication.

## Verification

Isolated PostgreSQL tests exercise persisted client projection/workflow/link, repeat conversion, stale version, wrong tenant, missing capability, suspended membership, anon denial, non-Won lead, ambiguous contact and foreign client link. An injected failure after client insertion rolls the whole operation back. Two concurrent committed database sessions produce one client, one workflow and one conversion audit event. Restart retains the committed result. Function removal/reapply is included in full-row reconciliation.

These are SQL tests, not a hosted login-to-browser conversion proof. The local preview has no authenticated business API. UI syntax/build and error-path browser checks do not replace an independent staging conversion with real Auth and representative data.

## Compatibility and rollout

Old arbitrary JSON writes can still overwrite relationship fields; this function cannot make every legacy writer transactional. Do not claim global exactly-once delivery. Reconcile old converted links/workflows and review duplicates before enabling the new path. Deploy the compatible additive migration before the application. A missing RPC fails closed; the client never falls back to unsafe browser conversion.

Rehearse against an independent staging restore, compare per-row hashes/tenant ownership/relationship counts, run concurrent conversion and full commercial gates, verify webhook behavior, then follow the normal rollout/rollback procedure. Rollback disables/drops the new command and retains converted business rows; never delete clients to undo a function deployment. Restoring the old browser workflow reintroduces partial-write risk and is not the preferred rollback.
