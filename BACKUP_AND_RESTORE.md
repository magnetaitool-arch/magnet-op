# Magnet OS — Backup & Restore

Zero-data-loss tooling. **Read this before any migration or deploy.** All scripts
are dependency-free Node 18+ and live in `tools/`. Backups are written to `/backups`
(gitignored). Nothing here deletes remote data.

## 0. One-time setup

```bash
cp .env.example .env      # then fill in the values (see below)
```

Minimum to back up business data (uses the public anon key already in the app):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`.
To also back up **accounts** (`_accounts`) and to **restore**, you need
`SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API → service_role).

## 1. Back up the cloud (`records` table)

```bash
npm run backup:supabase            # all collections -> backups/magnet-os-backup-<ts>.json
node tools/backup-supabase-records.js --coll=clients   # one collection
```

The file is a checksummed envelope:

```jsonc
{
  "version": "1.0",
  "createdAt": "2026-07-02T…Z",
  "source": "supabase:records",
  "project": "https://jdylrthffifbhyrrhuqd.supabase.co",
  "recordCount": 1234,
  "collections": { "clients": 40, "tasks": 220, … },
  "checksum": "sha256:…",           // over the records array, order-independent
  "records": [ { "id", "coll", "data", "updated_at" }, … ]
}
```

Pagination handles tables larger than PostgREST's 1000-row cap automatically.

## 2. Back up local (browser) data

Node can't read a browser's `localStorage`, so:

```bash
npm run backup:local               # prints a console snippet + instructions
node tools/backup-local-data.js --in=magnet-os-local-….json   # wrap an export
```

Either paste the printed snippet into the app tab's DevTools console (downloads a
JSON), or use **Settings → Backup Center → Export local backup** in the app. Then
wrap the download into a checksummed `/backups` envelope with `--in`.

## 3. Validate a backup (always before restoring)

```bash
npm run backup:validate backups/magnet-os-backup-<ts>.json
```

Checks JSON validity, envelope shape, record count, **duplicate IDs**, missing
collection names, corrupt `data` fields, and **checksum** integrity. Exit code 0 =
valid.

## 4. Restore into Supabase (safe by default)

```bash
# DRY-RUN (default): reports create/update/unchanged/conflict counts, writes nothing
npm run restore:supabase:dry backups/magnet-os-backup-<ts>.json

# APPLY: upsert-by-id only (never deletes), skips remote rows that are NEWER
npm run restore:supabase backups/magnet-os-backup-<ts>.json

# Force overwrite of newer remote rows (dangerous — only with a reason)
node tools/restore-supabase-records.js backups/….json --apply --overwrite-newer

# Restrict to one collection
node tools/restore-supabase-records.js backups/….json --apply --coll=clients
```

Guarantees:
- **Validates first** — aborts if the backup fails validation.
- **Never deletes** a remote row. Upsert only (`on_conflict=id`, merge-duplicates).
- **Conflict detection** — a remote row newer than the backup (by `updated_at`) is
  reported and **skipped** unless `--overwrite-newer`.
- Writes a **restore report** to `backups/restore-report-<ts>.json`.

## 5. Recommended cadence

- **Before every deploy or migration:** `npm run backup:supabase` and keep the file.
- The app also auto-exports rolling in-browser snapshots (Backup Center), and
  migration `001` creates an in-database snapshot table `records_backup_001`.
- For scheduled cloud backups: enable Supabase daily backups (paid) or cron
  `tools/backup-supabase-records.js` on any Node host with the env vars set.

## 6. Restore priority order (disaster recovery)

1. Newest valid `/backups/*.json` (validate → dry-run → apply).
2. In-database `records_backup_001` snapshot (from migration 001).
3. Supabase point-in-time / daily backup (dashboard).
4. Users' local browsers (each has a full `tia_agency_os_v2` copy; export via
   Backup Center and restore by importing, or wrap + restore via the tools).
