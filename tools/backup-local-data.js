#!/usr/bin/env node
// Magnet OS — local (browser localStorage) backup helper.
//
// Node cannot read a browser's localStorage directly, so this tool works two ways:
//
// 1) PRINT A SNIPPET (default): prints a one-liner to paste into the browser
//    DevTools console on the running app. It downloads a JSON of every Magnet OS
//    localStorage key. (The in-app Settings -> Backup Center does the same thing.)
//        node tools/backup-local-data.js
//
// 2) WRAP AN EXPORT: given a JSON file exported by the snippet or the Backup
//    Center, wrap it in the standard, checksummed backup envelope under /backups.
//        node tools/backup-local-data.js --in=path/to/export.json
'use strict';
const fs = require('node:fs');
const lib = require('./_lib');

const KEY_PREFIXES = ['tia_agency_os', 'tia_users', 'tia_current_user', 'tia_session', 'tia_permissions', 'tia_auth_settings', 'tia_acct_token', 'tia_backup', 'magnet'];

const SNIPPET =
`(function(){var P=${JSON.stringify(KEY_PREFIXES)};var out={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(P.some(function(p){return k.indexOf(p)===0;}))out[k]=localStorage.getItem(k);}` +
`var blob={version:'1.0',createdAt:new Date().toISOString(),source:'localStorage',origin:location.origin,keyCount:Object.keys(out).length,keys:out};` +
`var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(blob,null,2)],{type:'application/json'}));` +
`a.download='magnet-os-local-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();console.log('Exported '+blob.keyCount+' keys');})();`;

(async () => {
  const args = lib.parseArgs(process.argv);
  if (!args.in) {
    console.log('Magnet OS — local data backup');
    console.log('Node cannot read the browser localStorage. Do ONE of these:\n');
    console.log('  A) In the running app: Settings -> Backup Center -> Export local backup.\n');
    console.log('  B) Paste this into the app tab DevTools console (downloads a JSON):\n');
    console.log(SNIPPET + '\n');
    console.log('Then wrap the downloaded file into a checksummed /backups envelope:');
    console.log('  node tools/backup-local-data.js --in=magnet-os-local-*.json');
    return;
  }
  let data;
  try { data = lib.readJson(args.in); }
  catch (e) { console.error('ERROR: could not read/parse ' + args.in + ': ' + (e.message || e)); process.exit(1); }
  const keys = data.keys || data; // accept either the snippet blob or a bare {k:v}
  const keyCount = Object.keys(keys || {}).length;
  if (!keyCount) { console.error('ERROR: no localStorage keys found in the input file.'); process.exit(1); }
  const envelope = Object.assign(
    lib.makeEnvelope({ source: 'localStorage', project: data.origin || null, records: [] }),
    { keyCount, keys, checksum: lib.checksum(keys), recordCount: keyCount, collections: undefined }
  );
  delete envelope.records; delete envelope.collections;
  const file = lib.writeBackup(envelope);
  console.log(`OK — wrapped ${keyCount} localStorage key(s).`);
  console.log('Wrote ' + file);
  console.log('Checksum ' + envelope.checksum);
})();
