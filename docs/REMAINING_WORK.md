# Remaining release work

- **P0 · OWNER_ACTION_REQUIRED:** Enable the existing backup tooling by making Docker/Podman available, or provide an approved native PostgreSQL 17+ dump/restore toolchain. No paid Supabase upgrade is required for this tooling. Provider inventory currently has no verified recovery point.
- **P0 · IMPLEMENTABLE:** Create a complete protected production backup (database/Auth plus object bytes), rehearse recovery, and reconcile sanitized representative migration data before any production change.
- **P0 · IMPLEMENTABLE:** Finish hosted multi-role/session/storage and complete agency workflow E2E. Studio persistence has not been certified. Current passing hosted smoke tests do not satisfy the full release gate.
- **P1 · IMPLEMENTABLE:** After all gates pass, apply the 19 pending production migrations in order, verify reconciliation, promote the validated app and execute production smoke tests.
- **P1 · BLOCKED_EXTERNAL:** Actual Resend delivery and social publishing need their own provider credentials/approvals; these do not block unrelated features.
- **P2 · IMPLEMENTABLE:** Remaining mixed English labels in Arabic views; preserve the tested mobile layout.

PRIVATE Auth is intentionally paused under owner authorization. Resuming it while the two free slots are occupied will require freeing a slot; do not pause Magnet production automatically.
