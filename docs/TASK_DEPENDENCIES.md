# Task prerequisites

2026-09-26. Local implementation only; `20260925222507_task_dependencies.sql` is pending independent staging and production.

Tasks can now have explicit finish-to-start prerequisites from the same verified project/client. Managers search existing tasks, add/remove prerequisites and see incomplete work. Assigned staff can inspect their task's dependency state; a prerequisite they cannot otherwise read is labeled restricted without exposing its title. Client roles cannot read internal dependency controls.

Dependencies use tenant-composite foreign keys to canonical tasks. Add/remove commands are replay-safe, record audit/task events and retain removal tombstones. A tenant-scoped graph lock serializes cycle checks; opposite concurrent edges cannot both commit. New prerequisites may be added in Backlog, To Do or Blocked. Execution/review/completion transitions require active prerequisite tasks to be Done. Reopening a completed prerequisite is blocked while downstream work is active. Linked tasks cannot be moved between projects/clients until relationships are reviewed. These checks also apply to legacy status actions via the common server transition path.

No legacy dependency field is guessed, backfilled or deleted. This supports explicit prerequisites, not arbitrary cross-project scheduling, elapsed-time lags or recurring work.

## Verification

- 47 ordered migrations pass on isolated PostgreSQL 17, including dependency tests for cycles, concurrent opposite edges, execution gates, reopening, relationship drift, replay/audit/tombstones and tenant/anonymous/revoked access.
- Restricted staff see completion state with the private prerequisite title omitted and no management candidates/actions.
- The actual task screen added a prerequisite, rejected starting before completion, rejected a cycle with an actionable message, completed the prerequisite through task controls and then started the dependent task.
- English desktop and Arabic 390px mobile screens were visually inspected. No page overflow or browser exceptions were observed.
- Error messages now explain common task conflicts and prerequisite failures in both languages. Saved state remains intact on failure.

Hosted Supabase Auth, independent staging restore and production reconciliation remain release gates. No production data was migrated or deployment performed. Roll back task actions to read-only if needed; preserve graph, tombstones and audit history.
