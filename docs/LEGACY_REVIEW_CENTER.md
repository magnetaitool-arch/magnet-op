# Legacy Review Center

Existing source: `docs/LEGACY_DATA_REVIEW.md`. `node tools/legacy-review-source.js` parses its stable keys into a server import payload; it does not invent another case registry or embed business records in the published app. Import is service-only, tenant-checked, insert-only and repeatable. The existing 173 references retain 143 grouping keys; grouping does not silently close peer cases.

Settings → Data & Maintenance → Legacy Data Review requires active owner/admin membership and `organization.manage` on every RPC. Tables are not directly exposed to browser roles. Search runs server-side; contact details returned to the UI are masked. Summary export omits contact values, record payloads and notes.

Implemented repair actions:
- Contact identity links: explicitly choose the canonical reference. Link all listed live contact/lead records without merging, deleting, moving activities/opportunities or overwriting conflicting fields. Conflicting prior links stop the operation.
- Archived client/project parent: restore only the exact referenced parent after showing affected-child count. Other invalid relationships remain independent cases. Financial and employee parents are deliberately excluded.
- Unresolved task project: explicitly choose a same-workspace active project/client. Preserve status, assignment, dependency/history and archived state; verify the canonical task projection after the transaction. Existing verified project links are not overwritten.
- All categories: save a decision, request information, or explicitly retain/ignore the ambiguity. Retention closes as IGNORED, never falsely as repaired. Identity/finance/storage/policy cases have no speculative mutation action.

Every execution requires a fresh actor-bound 15-minute preview, exact case-ID confirmation, expected case version and idempotency key. Record locks and snapshot fingerprints reject changed evidence as NEEDS_REVIEW. Repairs run in a subtransaction; constraints, tenant relationships, relevant link/projection invariants and business-row counts are checked before RESOLVED. Failure rolls back the repair and preserves FAILED plus a sanitized diagnostic code in immutable history. No bulk Resolve All or generic Merge exists.

Migration is additive. Rollback withdraws these UI entry points and keeps cases/history; it must not drop owner decisions or reverse approved repairs without a new reviewed plan. Initial import applies no business decision. Restore rehearsal and subsequent production migration are recorded in FINAL_PRODUCTION_READINESS.md.
