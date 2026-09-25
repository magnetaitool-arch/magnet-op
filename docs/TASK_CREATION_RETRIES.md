# Retry-safe task creation

2026-09-26. Local implementation; migration `20260925222135_idempotent_task_creation.sql` remains pending staging/production.

The task editor now calls `create_task_command_v2` with a stable request ID for an unchanged payload. The server commits the task, creation event, assignment notification, audit and command ledger atomically. Concurrent or lost-response retries return the existing task with its current state after fresh permission checks. Changed payloads cannot reuse the same request ID. No browser-supplied status, organization, role or completion claims are accepted in the payload.

Create/update task RPCs validate active, unambiguous assignee membership and bounded hours/finite dates. A record trigger applies assignee checks to new browser-created tasks and reassignment through legacy raw writes; historical unchanged assignments are preserved. Service-side imports remain an explicit trusted path and still require reconciliation.

The editor prevents overlapping saves, disables its fields while saving, retains a failed form, and preserves initial project/client context from older entry points. Late modal loads are discarded and completed saves cannot close a subsequently opened modal. Existing details use optimistic version checks; a conflicting edit requires review.

Verification: 46 ordered migrations pass in isolated PostgreSQL 17. Tests cover concurrent deduplication, fresh replay, one task/event/notification, forged fields, invalid data, ambiguous owner, raw-owner bypass, revoked/tenant/anonymous denial and full rollback when ledger insertion fails. The committed command/task relationship survives database restart. Actual Arabic mobile UI was tested with a deliberately lost response after database commit: first attempt retained the form and error, second reused the same command ID and returned `replayed:true`, with one saved task and no page overflow/browser exceptions.

Email remains the existing post-response integration, separate from the transactional in-app notification. A lost response may therefore require an explicit email retry; this increment does not claim durable assignment-email delivery. Hosted staging/auth/provider delivery remain unverified. No production data or deployment was changed.
