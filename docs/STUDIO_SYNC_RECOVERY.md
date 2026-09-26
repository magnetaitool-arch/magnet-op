# Exact sync incident — 2026-09-27

- Request: POST `/rest/v1/records?on_conflict=id`, upsert of `public.records`.
- Collection / record: `gameScores` / `arc-usr-owner` (reaction game score). The global queue indicator appeared while Studio was open; it is not a Studio document save.
- Actor: Supabase user `c201b8ce-7c65-4d87-8f5e-99f28edcbbcc`, canonical role `owner`, ACTIVE membership.
- Workspace: `8c8f23cf-326e-4f3c-9186-bfdb0ba5dd17`. Client/project/storage: not involved.
- Confirmed mapping: `legacy_identity_links` connects `acct-usr-owner` to the actor with CONFIRMED status; the account's legacy subject is `usr-owner`.
- Failure: recorded HTTP 403 / PostgreSQL 42501. `records_authenticated_update` calls `records_can_write` for both existing-row USING and incoming-row WITH CHECK. A read-only transaction under the actual actor proved: read TRUE, incoming write TRUE (canonical createdBy stamped), existing write FALSE (only legacy userId present). Ownership is proven; no ambiguous Legacy Review decision is needed.
- Cause: deterministic legacy identifier compatibility defect (D/H). `record_matches_current_user` recognizes `acct-usr-owner` but not the account payload ID `usr-owner`; the old row therefore fails self-ownership even for its real owner. This must not be fixed by granting owners arbitrary game writes.

## Safe correction

Append-only migration `20260926230724_confirmed_game_identity_scope.sql` adds an internal helper and extends only the existing `gameScores`/`gameStats` branch. It recognizes a subject only through a CONFIRMED account mapping in the same organization, with an active nondeleted source account, active membership and no conflicting mapped owner. Existing permission paths remain. No row, score, owner identifier, membership, RLS policy or storage policy is edited. No browser service key or admin write bypass is introduced.

The diagnostic indicator exposes only current-scope record/actor/tenant identifiers and failure codes, never payloads or tokens. It also restores the retry handler when reusing a transient save indicator and supports keyboard retry. It never drops failed writes.

## Rehearsal and rollback

Independent staging transaction verified the old-identifier conflict upsert succeeds only for the confirmed owner; another active same-org user attempting that exact existing record with forged incoming createdBy gets 42501. Cross-tenant, unmapped and unconfirmed subjects remain denied; unrelated collections do not gain this compatibility path. Fixture and schema changes rolled back with row count unchanged before staging migration was committed. Fresh local behavioral suite includes this test. Production rollout compares every public table's row count and full fingerprint atomically. The latest encrypted backup was restore-tested (142 tables, three objects, 2,683 original values).

Rollback: restore the captured previous `records_can_write` definition, then drop the helper. Existing data remains untouched; the original queue stays blocked and retained.

## Remaining acceptance gate

The affected Safari retry now returns 401 because that session expired. User explicitly requested a pause after deployment for manual System Owner login. Do not reset credentials, clear browser state, or mark the exact sync operation resolved until the user logs in and the same pending write succeeds, persists after refresh/relogin, and the queue entry is removed only by confirmed success. Full Studio feature verification resumes after that gate; this report does not claim Studio complete.

## Applied release

Fix commit `9bdc16a`; production deployment `dpl_58hZLXraqhT2ey3qZZX9Zvsm8FpF` / `magnet-ov3qto6lc-magnetaitool-archs-projects.vercel.app`, primary alias `magnet-op.vercel.app`. Production ledger 66, canonical migrations 56. All 106 existing public table counts and full row fingerprints matched inside the migration transaction. The read-only actual-actor policy probe now returns owner/read TRUE/existing write TRUE/incoming write TRUE. Another active member of the same production workspace still gets existing-write FALSE. Staging actual upsert as an unauthorized member returned 42501 even with forged incoming authorship; inactive, conflicting and unconfirmed legacy mappings fail closed. Scoped lint/typecheck/build, sync diagnostics test and full local database suite passed.

Acceptance remains pending the explicitly requested manual Safari login. No password was requested or reset; no queued item was removed. Continue with the exact pending write, refresh/relogin persistence, Arabic/English Studio and then full feature recovery after login. Do not label that browser retest PASS before observing it.
