# Master build plan

This ledger implements the requested phase order. Existing code can cover parts of
later phases without making the earlier release gates complete. “Present” means
source exists; “verified” requires the named tests and environment evidence.

| Phase                  | Existing base                                                                                  | Remaining gate                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0 Audit/architecture   | Inventory, reference-license study, DB mapping, migration plan                                 | Read-only live DB inventory and backup now verified; full asset/license provenance remains open                    |
| 1 Foundation — CURRENT | Design tokens/themes, shell/search, canonical identity/tenancy/RBAC, client/storage migrations | Local foundation checks and 35-migration SQL rehearsal pass; independent hosted staging/auth/storage remains gated |
| 2 Execution            | Tasks/projects/briefs/requests/documents                                                       | Complete canonical project/brief/asset versions + client approval integration                                      |
| 3 Sales                | CRM conversion, proposals/activities                                                           | Transactional outreach/follow-ups/proposal versions; real daily score history                                      |
| 4 Audit/strategy       | Brief/report generators, separate artifacts                                                    | Structured findings, strategies, task lineage                                                                      |
| 5 Studio               | Standalone browser-draft prototype                                                             | Canonical persistence, brand kits, editor blocks, templates, deterministic export/share authorization              |
| 6 Content              | Calendar helpers                                                                               | Master/variant records, revision-bound approvals, composer, rescheduling                                           |
| 7 Publishing           | Durable general outbox/jobs                                                                    | Official Meta/TikTok adapters, OAuth, secret storage, worker leases/status/retry, explicit demo provider           |
| 8 Intelligence         | Existing reports/finance summaries                                                             | Provider-sourced metrics and Studio reporting loop                                                                 |
| 9 Operations           | Search/notifications and legacy automation                                                     | Unified authorized timeline/rules with spam and replay controls                                                    |
| 10 Optional AI         | No required paid AI service                                                                    | Disabled/Ollama/OpenAI-compatible boundary; core usable when disabled                                              |
| 11 Hardening           | Extensive local tests + staging scripts                                                        | Complete workflow E2E, actual database isolation, perf, exports, recovery and rollout                              |

## Current implementation increment

- Fail closed when hosted runtime configuration is invalid or absent.
- Never reveal privileged keys from public runtime configuration.
- Never infer first-owner eligibility from an empty browser cache or a failed API.
- Bilingual accessible checking/unavailable/retry screens; preserve normal sign-in
  and legitimate server-confirmed owner setup.
- Typed/executable auth-entry module; scoped lint/format/typecheck for new code.
- Safe preview and reproducible allowlisted production package with hashes.
- Regression/unit and HTTP integration tests; local desktop/mobile browser checks.
- Native isolated PostgreSQL harness: 47 ordered migrations, real RLS/role queries,
  concurrent profile creation, storage lifecycle checks, and restart persistence.
- Thirteen unapplied local migrations: profile provisioning, fresh upload/task authorization,
  unambiguous task identity, atomic lead conversion, durable CRM follow-ups, proposal
  revisions/public review, approval recipient identity, accepted-proposal discovery and
  authoritative workflow transitions, shared persistent onboarding and atomic project setup.
- Read-only live production metadata and public-table backup, with validated hashes
  and counts. Auth inventory/storage metadata are not a full managed recovery backup.

## Phase gates

Run `format:check`, `lint`, `typecheck`, `test`, `verify:security`, `build`, plus
relevant integration/E2E tests. New modules use strict checked JS/TypeScript tooling;
the embedded legacy shell retains its syntax/security suite until incrementally
extracted. Never claim the entire monolith has strict type coverage.

Database changes additionally require live inspection, complete validated backup,
restored independent staging, migration rehearsal, tenant/role tests, count parity,
and rollback validation. Missing credentials/environment are an explicit blocked
gate, not a passed test. Current work stays in Phase 1 until that gate is satisfied.

## Acceptance trajectories

- Sales: lead → outreach → follow-up → sent proposal → won → same client UUID.
- Execution: client → brief → project → assigned task → asset v2 → review/approval.
- Content: master + platform variants → approve exact revision → calendar schedule.
- Publishing: leased job → explicit DEMO result or verified provider post/status;
  expired token/rate limit/unknown result never become fake success.
- Studio: structured source → editable pages/blocks → client brand → preview → PDF.
- AI: disabled mode fully usable; local provider outage never blocks core work.

Each trajectory needs real persistence after reload, restricted-role/cross-tenant
checks, idempotent retry and failure-path tests before it is marked complete.

## 2026-09-26 independent remediation

Session refresh/identity outage handling, explicit workspace selection and CSP hash enforcement are implemented with local tests. Persistent follow-ups, completion-to-next-action, CRM queues and the authenticated due-reminder adapter are implemented and tested on isolated PostgreSQL and the actual browser UI. See [session/CSP evidence](SESSION_AND_CSP_REPAIR.md) and [follow-up migration/evidence](DURABLE_CRM_FOLLOWUPS.md). These independent improvements do not close hosted Phase 1 gates.

- Project execution now retains immutable submitted-brief versions and displays them in project/task detail. Task/project references are tenant/client validated with additive nullable FKs and unresolved-legacy issue reporting. See `PROJECT_BRIEF_RELATIONSHIPS.md`; this does not close Phase 1 hosted gates or the remaining Phase 2 scope.

- Task status authority now covers legacy boards and task modals. Exact task IDs replace code-search detail lookup. The rollback rehearsal compares restored function definitions as well as data. See `TASK_STATUS_AUTHORITY.md`.

- Interactive task creation uses a durable idempotency ledger. Concurrent and lost-response retries are verified with one task/event/notification; assignment checks reject ambiguous or inactive logins. See `TASK_CREATION_RETRIES.md`.

- Same-project prerequisites now have persistent tenant FKs, cycle protection, safe retries and execution/reopening gates. Actual task controls were verified through prerequisite completion in English/Arabic; see `TASK_DEPENDENCIES.md`.
