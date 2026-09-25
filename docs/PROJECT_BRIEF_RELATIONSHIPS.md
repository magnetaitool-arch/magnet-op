# Project briefs and task relationships

2026-09-26. Implemented locally; no production application or database rollout.

## Existing behavior and repair

Submitted public briefs persist in `records`, but project execution previously used unrelated copied text/URLs. `project_brief_revisions_v2` now retains an immutable, explicitly selected snapshot of a submitted brief belonging to the same canonical client as the existing project. The project remains the original `records` entity; no parallel project model is introduced.

The snapshot includes operational answers and source submission date. Tokens, contact phone/name, consent and internal staff notes are excluded. Capturing a snapshot is not client approval, a signature or automatic workflow advancement. Source edits/reopening/deletion mark the source changed while preserving historical execution versions. Current source hash and expected project revision prevent stale capture; concurrent retries produce one revision/audit event. Replays require current permissions and return current state. Authenticated callers cannot directly write the snapshot table.

The project panel supports source selection, immutable version history, a changed-source notice and recoverable loading/save errors in Arabic and English. Task detail displays the same project brief read-only rather than copying another text field. Existing free-text project briefs remain preserved and explicitly labeled as legacy notes.

Task projections now have a nullable `project_reference_id` with a composite tenant/project foreign key to `records`. Backfill links only rows with matching project collection, tenant and canonical client. Unresolved legacy rows remain unchanged and receive a `PROJECT_RELATIONSHIP_REVIEW_REQUIRED` issue. New authenticated task relationships and execution transitions must point to an available project/client. Historical metadata can still be corrected; explicit valid relationship repair resolves the issue. Referenced project tenant/client/collection changes and task projection identity changes are rejected. Projects are not silently reassigned to another client.

## Verification and reconciliation

- 44 ordered migrations pass on isolated PostgreSQL 17 with synthetic platform fixtures.
- The task relationship migration is rehearsed with representative valid and unresolved pre-migration tasks. All source row values and counts remain unchanged; valid links populate, unresolved rows remain and are flagged.
- Snapshot tests cover private-field exclusion, immutable history, source/version conflicts, client/tenant mismatch, direct-write/anonymous denial, revocation and fresh replay. Two committed concurrent requests produce one snapshot. The saved snapshot survives database restart.
- Task relationship tests cover raw-record bypass, project client/tenant drift, hard-delete restriction, unresolved historical preservation, blocked execution and explicit relationship repair.
- The actual project panel saved a snapshot through the isolated SQL adapter, reloaded it after page refresh, and displayed it in Arabic at 390px without overflow. A simulated network failure preserved the saved brief and displayed a retry error. No browser exceptions were observed. These tests do not certify hosted Supabase Auth or storage.

## Migration and rollback

Pending additive migrations:

- `20260925220521_project_brief_snapshots.sql`
- `20260925220952_task_project_relationships.sql`

Rehearse on independent hosted staging before release. Assess unique-index/FK lock duration on a restored representative dataset and reconcile task/project/client counts, valid references, unresolved issues and source hashes. No existing source record is rewritten or removed. Snapshot-enrolled project/brief identity changes require a deliberate reviewed migration rather than generic edits. Roll back application entry points if needed; retain historical snapshots, audit and verified references. Do not deploy this UI before compatible migrations exist.

Still incomplete: structured brief authoring/review approval, fully server-authorized project edit/lifecycle commands, task dependencies/recurrence, exact asset-version approvals and the remaining agency workflow phases. Independent hosted staging, full backup/restore and production reconciliation remain external release blockers.
