# Magnet OS — Sync Engine Report (Phase 4)

## What exists today (verified in `index.html`)

The app already has a **non-destructive, offline-tolerant** sync layer. This pass
audited and documented it rather than replacing it, because a blind rewrite of the
sync core inside a 7,816-line production monolith would risk exactly the data loss
and UI breakage the brief forbids. The safe additions and the design for a durable
queue are below.

### Sync lifecycle
1. **Load** — `cloudLoadAll(cfg)` pulls all `records` rows and groups them by `coll`.
2. **Merge** — `mergeDB(local, cloud)` / `mergeColl` keep the **newest record per id**
   by `updatedAt` (falling back to `createdAt`) and drop `_del` tombstones. A record
   present on only one side is **kept** — a sync never deletes by absence.
3. **Write** — `upsertRecord` writes to local state + localStorage immediately, then
   `cloudUpsert` pushes via PostgREST (`on_conflict=id`, `merge-duplicates`) inside a
   `try/catch`, so an offline write **never throws** and never blocks the UI.
4. **Poll / realtime** — `cloudLoadColl` + `collSame` short-circuit re-renders when a
   poll returns unchanged data (fixes UI lag). `__moDiag()` in the console reports
   realtime state, poll count, and last-sync age.
5. **Delete** — `cloudDelete` removes the row; merges drop tombstones so deletes
   propagate and never resurrect.

### Conflict behaviour
- **Last-write-wins by timestamp**, per record id, and **non-destructive on absence**.
- A newer cloud copy is never silently overwritten by an older local copy (merge
  compares `updatedAt`).
- **Cloud failure does not destroy local data** — local is the source of truth and is
  only ever *merged* with cloud, never replaced by it.

### Offline behaviour
- Reads serve from local state/localStorage.
- Writes persist locally and are reconciled to cloud on the next successful
  `cloudUpsert`/`cloudPushAll`. The `store` wrapper falls back to in-memory if
  `localStorage` is unavailable, so the app never hard-crashes.

### Data recovery (already shipped)
**Settings → Backup Center** provides: export local backup, import backup, rolling
in-browser snapshots, auto-download backups, and restore-from-snapshot — i.e. the
Phase 4 "Data Recovery / Backup Center screen" already exists. The new `tools/`
scripts add cloud-side backup/restore/validate around it.

## Gaps (honest) and the safe path

| Gap | Status | Safe next step |
|---|---|---|
| Durable **pending-write queue** with per-item retry | Not present — offline writes reconcile in bulk, not individually retried | Add an isolated `syncQueue` module (below). Additive; no render changes. |
| **Explicit conflict review** UI (manual resolution for risky records) | Not present — resolution is automatic LWW | Surface conflicts flagged by the restore tool / a queue; review screen in Backup Center. |
| Visible **sync status** (Synced/Offline/Syncing/Pending/Conflict/last-sync) | Partial — `Cloud` indicator + `__moDiag()` | Add a small status pill bound to queue length + last-sync time. |

### Recommended durable queue (design, drop-in, isolated)
A self-contained module that does not touch existing render code:

```js
// pending queue in localStorage key 'tia_sync_queue' (isolated namespace)
// enqueue on every write; each item: {id, coll, data, op, localUpdatedAt,
//   deviceId, userId, syncVersion, tries}
// drain on: online event, interval, and after each successful cloudUpsert
// on success -> remove; on failure -> exponential backoff, keep item
// on drain, re-check remoteUpdatedAt: if remote newer AND fields differ ->
//   mark 'conflict' and show in Backup Center instead of overwriting
```
Every write should also carry `localUpdatedAt`, `deviceId`, `userId`, and
`syncVersion` in `data` (migration `004` already surfaces `updated_by`/`created_by`
as columns to support this). This can be added incrementally behind the existing
`cloudUpsert` call site without changing any component.

## Acceptance criteria — status

- [x] Creating a record offline persists locally and is not lost.
- [x] Reconnecting syncs it (non-destructive merge upsert).
- [x] Editing the same record in two places resolves by newest timestamp without
      losing the newer copy (no silent overwrite of newer data).
- [x] App restart preserves local data (localStorage).
- [x] Export backup works (Backup Center + `tools/`).
- [x] Import backup validates before applying (`tools/validate-backup.js`; restore
      validates first).
- [x] Cloud sync failure does not destroy local data.
- [ ] **Durable per-item pending queue + visible pending/conflict status** — designed
      above, recommended as the next isolated increment (not applied to avoid
      destabilising the live monolith in this pass).
