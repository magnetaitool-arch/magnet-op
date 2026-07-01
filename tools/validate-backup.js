#!/usr/bin/env node
// Magnet OS — validate a backup file before trusting/restoring it.
// Checks: JSON validity, envelope shape, record count, duplicate IDs, missing
// collection names, corrupted data fields, and checksum integrity.
//
//   node tools/validate-backup.js backups/magnet-os-backup-....json
'use strict';
const lib = require('./_lib');

function validate(file) {
  const problems = [];
  const warnings = [];
  let doc;
  try { doc = lib.readJson(file); }
  catch (e) { return { ok: false, problems: ['Invalid JSON: ' + (e.message || e)], warnings: [] }; }

  if (!doc || typeof doc !== 'object') return { ok: false, problems: ['Root is not an object'], warnings: [] };
  if (!doc.version) warnings.push('Missing "version" field');
  if (!doc.createdAt) warnings.push('Missing "createdAt" field');
  if (!doc.source) warnings.push('Missing "source" field');

  // localStorage-style backup (keys map, no records array)
  if (doc.source === 'localStorage' || (doc.keys && !doc.records)) {
    const keys = doc.keys || {};
    const n = Object.keys(keys).length;
    if (doc.keyCount != null && doc.keyCount !== n) problems.push(`keyCount ${doc.keyCount} != actual ${n}`);
    if (doc.checksum) {
      const got = lib.checksum(keys);
      if (got !== doc.checksum) problems.push(`Checksum mismatch (stored ${doc.checksum}, computed ${got})`);
    } else warnings.push('No checksum to verify');
    return { ok: problems.length === 0, problems, warnings, summary: { kind: 'localStorage', keys: n } };
  }

  // records-style backup
  const records = doc.records;
  if (!Array.isArray(records)) return { ok: false, problems: ['"records" is not an array'], warnings };
  if (doc.recordCount != null && doc.recordCount !== records.length) problems.push(`recordCount ${doc.recordCount} != actual ${records.length}`);

  const ids = new Set();
  const dupIds = new Set();
  let missingColl = 0, missingId = 0, badData = 0;
  for (const r of records) {
    if (!r || typeof r !== 'object') { badData++; continue; }
    if (!r.id) missingId++;
    else { if (ids.has(r.id)) dupIds.add(r.id); ids.add(r.id); }
    if (!r.coll) missingColl++;
    if (r.data == null || typeof r.data !== 'object') badData++;
  }
  if (missingId) problems.push(`${missingId} record(s) missing an id`);
  if (dupIds.size) problems.push(`${dupIds.size} duplicate id(s), e.g. ${[...dupIds].slice(0, 3).join(', ')}`);
  if (missingColl) problems.push(`${missingColl} record(s) missing a collection name`);
  if (badData) problems.push(`${badData} record(s) with missing/corrupt "data" object`);

  if (doc.checksum) {
    const got = lib.checksum(records);
    if (got !== doc.checksum) problems.push(`Checksum mismatch (stored ${doc.checksum}, computed ${got})`);
  } else warnings.push('No checksum to verify');

  return { ok: problems.length === 0, problems, warnings, summary: { kind: 'records', records: records.length, collections: lib.collectionsSummary(records) } };
}

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/validate-backup.js <backup.json>'); process.exit(2); }
const r = validate(file);
console.log('Validating ' + file);
if (r.summary) console.log('Summary:', JSON.stringify(r.summary));
for (const w of r.warnings) console.log('  WARN: ' + w);
for (const p of r.problems) console.log('  FAIL: ' + p);
if (r.ok) { console.log('VALID — backup passed all checks.' + (r.warnings.length ? ' (with warnings)' : '')); process.exit(0); }
console.log('INVALID — do NOT restore this file until fixed.');
process.exit(1);

module.exports = { validate };
