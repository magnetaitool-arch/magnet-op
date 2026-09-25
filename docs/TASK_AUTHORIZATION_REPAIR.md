# Task status authorization repair

The live `change_task_status_v2` function permits an assigned identity without
requiring current active membership or `work.read`. The PostgreSQL workflow test
reproduced successful status mutation after suspension. Existing UI/RLS reads do
not protect a security-definer mutation.

Replace this function in a new migration, requiring fresh active membership and
work-read permission before loading the task. Keep the existing manager/assignee,
expected-version and transition checks. No task rows, assignments or history are
rewritten. The SQL signature and valid authorized behavior remain compatible.

The representative fixture must include the existing `fill_sync_meta` trigger;
otherwise task creation fails on null projection timestamps for a reason that does
not represent the live system. That fixture correction is separate from the fix.

Evidence: 2026-09-25 private schema/data export, validated checksums, reconciliation
report and native database workflow reproduction. Rehearse on independent hosted
staging before remote application. Test active execution/review, notifications,
suspension, revoked capabilities, wrong tenant and stale revision. Rollback should
prefer pausing task mutations; reinstating the old function restores a known
permission defect. No production application or production data migration occurs
in this change. Pending project/employee identity ambiguities are not auto-repaired.
