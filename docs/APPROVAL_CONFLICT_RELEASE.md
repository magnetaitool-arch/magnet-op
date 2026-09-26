# Approval conflict repair — 2026-09-26

Observed on production with isolated QA data: approving a deliverable succeeds, but replaying its old expected status does not return within 15/30 seconds. The persisted approval remains correct. `40001` incorrectly marks a business-state conflict as a retryable database serialization failure.

Migration `20260926201628_approval_conflict_http_status.sql` changes only that exception in `transition_approval_v2` to PostgREST `PT409`. Signature, permissions, tenant checks, notification logic, tables and business data stay unchanged. Application code already handles unsuccessful commands and reloads authoritative state.

Independent hosted staging `vsurqqbxjvqzvqbmetjw`: normal approval passed; stale retry returned HTTP 409 / `approval_status_conflict` in 260 ms; record unchanged. Restoring the prior function and reapplying the repair both passed. Prior production function is saved privately for rollback; no business-data rollback is needed.

Pre-change production backup: one consistent read-only snapshot of all 134 public/Auth/Storage/migration tables, including server-only collections, 17,514 rows, per-table counts and SHA-256. This supplements the existing encrypted, fully restored schema/data backup. No production reset, deletion or identity repair is part of this release.

Production repair applied successfully. Stale approval returned HTTP 409 in 242 ms; persisted approval unchanged. Three function-only repairs now recorded in ledger 61; each transaction compared counts/full-row fingerprints across 11 critical tables with no business-data changes. Actual employee submission, manager approval/completion, list and timeline subsequently passed. See POST_DEPLOY_VERIFICATION.md.

## Employee request submission

The production browser found `column reference "step_no" is ambiguous` when submitting a general employee request. Migration `20260926202101_employee_request_step_reference.sql` qualifies the routing-step column in the direct and saved-draft submission functions. It changes no approval rule or business record. Independent staging verified direct submission, idempotent retry, requester self-approval denial, assigned-manager approval and saved-draft submission; restoring/reapplying the original functions was rehearsed. A new full native PostgreSQL dump was completed before production application. Rollback consists only of restoring the two saved prior function definitions.

## Employee request lists

After submission was repaired, the actual production UI exposed a separate `relation "allowed" does not exist` error in list loading: the authorized CTE was referenced by a second SQL statement outside its scope. Migration `20260926202527_employee_request_list_scope.sql` computes the count and page in the same statement, retaining every authorization/filter predicate. Staging regression now covers MINE, AUTHORIZED, QUEUE, TEAM_CALENDAR, detail/timeline and the assigned manager's queue, in addition to submission/approval. Rollback/reapply was rehearsed; a fresh complete 134-table consistent snapshot precedes production application.
