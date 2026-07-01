#!/usr/bin/env node
// Magnet OS — restore records from a backup file into Supabase. SAFE BY DEFAULT:
//   * DRY-RUN unless you pass --apply
//   * NEVER deletes remote rows (upsert only, on_conflict=id merge-duplicates)
//   * validates the backup first (checksum, duplicates, shape)
//   * detects conflicts: a remote row NEWER than the backup row (by updated_at)
//   * writes a restore report to /backups/restore-report-<timestamp>.json
//
//   node tools/restore-supabase-records.js backups/magnet-os-backup-....json           # dry-run
//   node tools/restore-supabase-records.js backups/....json --apply                    # write
//   node tools/restore-supabase-records.js backups/....json --apply --overwrite-newer  # also overwrite newer remote (dangerous)
//   node tools/restore-supabase-records.js backups/....json --coll=clients             # restrict to one collection
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_KEY.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./_lib');
const { validate } = require('./validate-backup');

const ts = (r) => Date.parse((r && r.updated_at) || (r && r.data && (r.data.updatedAt || r.data.createdAt)) || 0) || 0;

(async () => {
  const args = lib.parseArgs(process.argv);
  const file = args._[0];
  if (!file) { console.error('Usage: node tools/restore-supabase-records.js <backup.json> [--apply] [--overwrite-newer] [--coll=name]'); process.exit(2); }
  const apply = !!args.apply;
  const overwriteNewer = !!args['overwrite-newer'];

  // 1) Validate before touching anything.
  const v = validate(file);
  if (!v.ok) { console.error('Backup FAILED validation — aborting. Run: node tools/validate-backup.js ' + file); v.problems.forEach((p) => console.error('  FAIL: ' + p)); process.exit(1); }

  const doc = lib.readJson(file);
  let records = (doc.records || []).filter((r) => r && r.id && r.coll);
  if (args.coll) records = records.filter((r) => r.coll === args.coll);
  if (!records.length) { console.error('Nothing to restore (no matching records).'); process.exit(1); }

  const cfg = lib.getConfig();
  if (!cfg.key) { console.error('ERROR: no Supabase key. Set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY in .env'); process.exit(1); }

  console.log(`Restore ${records.length} record(s) from ${file}`);
  console.log(`Target ${cfg.url} (${cfg.keyKind} key) — mode: ${apply ? 'APPLY' : 'DRY-RUN'}${overwriteNewer ? ' +overwrite-newer' : ''}`);

  // 2) Read current remote state to classify each record.
  let remote = [];
  try { remote = await lib.fetchAllRecords(cfg, args.coll); }
  catch (e) { console.error('ERROR reading remote state: ' + (e.message || e)); process.exit(1); }
  const remoteById = new Map(remote.map((r) => [r.id, r]));

  const plan = { create: [], update: [], conflictNewerRemote: [], unchanged: [] };
  for (const r of records) {
    const cur = remoteById.get(r.id);
    if (!cur) { plan.create.push(r); continue; }
    if (lib.stableStringify(cur.data) === lib.stableStringify(r.data)) { plan.unchanged.push(r); continue; }
    if (ts(cur) > ts(r)) plan.conflictNewerRemote.push({ id: r.id, coll: r.coll, remoteUpdated: cur.updated_at, backupUpdated: r.updated_at });
    else plan.update.push(r);
  }

  // Records to actually upsert: creates + safe updates, plus conflicts only if forced.
  const toWrite = [...plan.create, ...plan.update, ...(overwriteNewer ? plan.conflictNewerRemote.map((c) => records.find((r) => r.id === c.id)) : [])].filter(Boolean);

  console.log(`  create: ${plan.create.length}  update: ${plan.update.length}  unchanged: ${plan.unchanged.length}  conflict(newer remote): ${plan.conflictNewerRemote.length}`);
  if (plan.conflictNewerRemote.length && !overwriteNewer) console.log('  -> conflicts SKIPPED (remote is newer). Re-run with --overwrite-newer to force.');

  let written = 0;
  if (apply && toWrite.length) {
    const rows = toWrite.map((r) => ({ id: r.id, coll: r.coll, data: r.data }));
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const res = await fetch(cfg.url + '/rest/v1/records?on_conflict=id', {
        method: 'POST',
        headers: lib.restHeaders(cfg.key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(chunk),
      });
      if (!res.ok) { console.error(`  ERROR writing chunk ${i}: ${res.status} ${await res.text().catch(() => '')}`); break; }
      written += chunk.length;
      console.log(`  wrote ${written}/${rows.length}`);
    }
  }

  // 3) Restore report.
  const report = {
    generatedAt: new Date().toISOString(),
    backupFile: path.resolve(file),
    target: cfg.url, keyKind: cfg.keyKind,
    mode: apply ? 'apply' : 'dry-run', overwriteNewer,
    counts: { create: plan.create.length, update: plan.update.length, unchanged: plan.unchanged.length, conflictNewerRemote: plan.conflictNewerRemote.length, written },
    conflicts: plan.conflictNewerRemote,
  };
  lib.ensureBackupDir();
  const rf = path.join(lib.BACKUP_DIR, `restore-report-${lib.stamp()}.json`);
  fs.writeFileSync(rf, JSON.stringify(report, null, 2));
  console.log('Report ' + rf);
  if (!apply) console.log('DRY-RUN complete — no data was written. Re-run with --apply to perform the restore.');
  else console.log(`APPLIED — ${written} record(s) upserted. No rows were deleted.`);
})();
