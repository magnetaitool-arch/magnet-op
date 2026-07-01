#!/usr/bin/env node
// Magnet OS — export the entire Supabase `records` table to a timestamped JSON
// backup under /backups. READ-ONLY: it never writes or deletes anything remote.
//
//   node tools/backup-supabase-records.js            # all collections
//   node tools/backup-supabase-records.js --coll=clients
//
// Requires (in .env or the environment):
//   SUPABASE_URL                = https://jdylrthffifbhyrrhuqd.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   = <service_role>   (recommended: includes _accounts)
//   or SUPABASE_KEY / SUPABASE_ANON_KEY            (reads whatever anon may read)
'use strict';
const lib = require('./_lib');

(async () => {
  const args = lib.parseArgs(process.argv);
  const cfg = lib.getConfig();
  if (!cfg.key) {
    console.error('ERROR: no Supabase key found. Set SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_KEY in .env');
    console.error('       Copy .env.example to .env and fill it in. Nothing was written.');
    process.exit(1);
  }
  console.log(`Backing up records from ${cfg.url} using ${cfg.keyKind} key…`);
  let records;
  try {
    records = await lib.fetchAllRecords(cfg, args.coll);
  } catch (e) {
    console.error('ERROR: ' + (e && e.message || e));
    console.error('Hint: did you run supabase-schema.sql, and is the key correct?');
    process.exit(1);
  }
  const hasAccounts = records.some((r) => r.coll === '_accounts');
  const envelope = lib.makeEnvelope({
    source: 'supabase:records',
    project: cfg.url,
    records,
    extra: { keyKind: cfg.keyKind, includesAccounts: hasAccounts, collFilter: args.coll || null },
  });
  const file = lib.writeBackup(envelope);
  console.log(`OK — ${records.length} record(s) across ${Object.keys(envelope.collections).length} collection(s).`);
  if (!hasAccounts && cfg.keyKind !== 'service_role') {
    console.log('NOTE: _accounts not included (anon key + lockdown). Use SUPABASE_SERVICE_ROLE_KEY to back up accounts.');
  }
  console.log('Wrote ' + file);
  console.log('Checksum ' + envelope.checksum);
})();
