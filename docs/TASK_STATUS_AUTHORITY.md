# Authoritative task status

2026-09-26. Local implementation only; migration `20260925221432_task_status_authority.sql` is pending staging and production.

The canonical task screen used an authorized transition command, but legacy boards/detail/quick completion still wrote status and completion attribution directly. A new record guard rejects those browser writes. `change_task_record_status_v2` resolves the exact tenant task, compares the displayed status and calls the same capability/assignee/version/state-machine command. Completion time/user and status history are server-owned. Initial browser tasks cannot start already approved/delivered/completed. Existing historical statuses remain untouched.

`modules/task-status.js` installs only a confirmed server result. Legacy completion actions await it; failures retain the prior state and show an error. Project-board cards display pending/error states and translated Arabic controls. Task modals opened from older entry points now use the canonical task editor. The editor preserves existing unknown legacy fields through the update RPC. Task-detail failure messages survive the recovery read instead of being cleared. Late asynchronous cache commits are checked against the current user and workspace.

`get_task_v2` previously searched a task code and took the first result. Duplicate historical codes could therefore return a different task's details. It now serializes the exact authorized row selected by UUID. Codes are preserved, not renamed or guessed.

## Verification

- 45 ordered migrations pass in isolated PostgreSQL 17; direct status/completion forgery, invalid transition, stale legacy status, anonymous/cross-tenant/revoked access are rejected.
- Duplicate-code fixtures return their exact requested task UUID. Valid transitions produce server attribution and one event each. The transaction-local command marker is restored after use.
- The client helper never commits failed, malformed or wrong-task responses and refuses mixed status/detail writes.
- The actual legacy project board changed a stored task from Backlog to In Progress through the new RPC and updated its displayed value after confirmation. The canonical editor opened from a legacy task ID, saved an Arabic title and retained the form on error. Arabic mobile inputs are full width and 44px high, without page overflow. Browser errors were clear after the fixed rehearsal.
- Browser QA exposed the rollback harness reapplying an older status function after the main tests. The rehearsal now restores the latest function and compares all public function definitions before/after, as well as all business row values/relationships.

## Limits / rollout

This is not full task-system completion. Retry-safe task creation is now implemented and verified in TASK_CREATION_RETRIES.md. Dependencies, recurrence, robust subtasks and immutable asset approval remain separate work. Legacy metadata writes outside the canonical editor still use the old sync path and require further extraction. Generic task-create branches remain present for compatibility but the interactive task modal now uses canonical APIs.

Deploy the compatible migration before the app. Rehearse on independent hosted staging, test assigned users and managers, and reconcile task/event counts. Retain history and records during rollback; make task-state actions read-only if the command path must be withdrawn. No production migration or deployment has been performed.
