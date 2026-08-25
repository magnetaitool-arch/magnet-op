#!/usr/bin/env node
'use strict';

/**
 * Read-only M0 validation for a Production logical snapshot restored to a
 * completely separate Supabase Staging project.
 *
 * This script never sends DDL or DML. It writes only a private local report
 * under the supplied gitignored backups/ directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const pos = raw.indexOf('=');
    if (pos === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, pos)] = raw.slice(pos + 1);
  }
  return out;
}

function safeError(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(-4000);
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizeAcl(value) {
  const text = String(value || '');
  if (!text.startsWith('{') || !text.endsWith('}')) return text;
  return `{${text.slice(1, -1).split(',').filter(Boolean).sort().join(',')}}`;
}

function normalizeInventory(kind, value) {
  if (kind !== 'functions') return value;
  return value.map((item) => ({ ...item, acl: normalizeAcl(item.acl) }));
}

function commandJson(cliJs, args) {
  const result = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) throw new Error(safeError(result.stderr || result.stdout));
  const stdout = String(result.stdout || '');
  const arrayStart = stdout.indexOf('[');
  const objectStart = stdout.indexOf('{');
  const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) throw new Error(`Command returned no JSON: ${safeError(stdout)}`);
  return JSON.parse(stdout.slice(start));
}

function query(cliJs, projectRef, sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('Validation query must be read-only SELECT/WITH SQL.');
  const payload = commandJson(cliJs, [
    'db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql,
  ]);
  if (!Array.isArray(payload.rows)) throw new Error('Query response has no rows array.');
  return payload.rows;
}

function countsFor(cliJs, projectRef, tables) {
  const sql = tables.map((table) =>
    `select ${quoteLiteral(table)} as table_name,count(*)::bigint as row_count from public.${quoteIdent(table)}`
  ).join(' union all ');
  return Object.fromEntries(query(cliJs, projectRef, sql).map((row) => [row.table_name, Number(row.row_count)]));
}

function collectionCounts(cliJs, projectRef) {
  return Object.fromEntries(query(cliJs, projectRef, `
    select coll,count(*)::bigint as row_count from public.records group by coll order by coll
  `).map((row) => [row.coll, Number(row.row_count)]));
}

function schemaInventory(cliJs, projectRef) {
  return {
    policies: query(cliJs, projectRef, `
      select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies where schemaname in ('public','storage')
      order by schemaname,tablename,policyname
    `),
    functions: query(cliJs, projectRef, `
      select n.nspname as schema_name,p.proname as function_name,
             pg_get_function_identity_arguments(p.oid) as identity_arguments,
             p.prosecdef as security_definer,p.proacl as acl,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' order by 1,2,3
    `),
    triggers: query(cliJs, projectRef, `
      select n.nspname as schema_name,c.relname as table_name,t.tgname as trigger_name,
             pg_get_triggerdef(t.oid,true) as definition,t.tgenabled as enabled
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and not t.tgisinternal order by 1,2,3
    `),
    extensions: query(cliJs, projectRef, `
      select e.extname as extension_name,e.extversion as version,n.nspname as schema_name
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname
    `),
    migrations: query(cliJs, projectRef, `
      select version,name from supabase_migrations.schema_migrations order by version
    `),
  };
}

function edgeFunctions(cliJs, projectRef) {
  const value = commandJson(cliJs, ['functions', 'list', '--project-ref', projectRef, '--output', 'json']);
  const rows = Array.isArray(value) ? value : (value.functions || []);
  return rows.map((item) => ({
    name: item.name,
    status: item.status,
    verify_jwt: item.verify_jwt,
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function sumCollections(counts, names) {
  return names.reduce((sum, name) => sum + Number(counts[name] || 0), 0);
}

const args = parseArgs(process.argv);
const productionRef = String(args['production-ref'] || '').trim();
const stagingRef = String(args['staging-ref'] || '').trim();
const expectedStagingName = String(args['expected-staging-name'] || 'MAGNET OS STAGING');
const backupDir = path.resolve(String(args['backup-dir'] || ''));
const cliJs = path.resolve(String(args['cli-js'] || ''));

if (!/^[a-z]{20}$/.test(productionRef) || !/^[a-z]{20}$/.test(stagingRef) || productionRef === stagingRef) {
  console.error('ERROR: explicit, different Production and Staging project refs are required.');
  process.exit(2);
}
if (!args['backup-dir'] || !backupDir.includes(`${path.sep}backups${path.sep}`)) {
  console.error('ERROR: --backup-dir must be an explicit path under backups/.');
  process.exit(2);
}
if (!fs.existsSync(cliJs)) {
  console.error('ERROR: Supabase CLI entrypoint not found.');
  process.exit(2);
}

const backup = JSON.parse(fs.readFileSync(path.join(backupDir, 'logical-backup.json'), 'utf8'));
if (backup.sourceProjectRef !== productionRef) {
  console.error('REFUSED: backup does not belong to the declared Production project.');
  process.exit(2);
}

const projects = commandJson(cliJs, ['projects', 'list', '--output', 'json']);
const production = projects.find((project) => project.ref === productionRef);
const staging = projects.find((project) => project.ref === stagingRef);
if (!production || production.status !== 'ACTIVE_HEALTHY') {
  console.error('REFUSED: Production project is unavailable or unhealthy.');
  process.exit(2);
}
if (!staging || staging.name !== expectedStagingName || staging.status !== 'ACTIVE_HEALTHY') {
  console.error('REFUSED: Staging project identity/name/health check failed.');
  process.exit(2);
}

const tables = Object.keys(backup.publicData).sort();
const snapshotTableCounts = Object.fromEntries(tables.map((table) => [table, backup.publicData[table].length]));
const snapshotCollections = Object.fromEntries(backup.collections.map((row) => [row.coll, Number(row.row_count)]));
const stagingTableCounts = countsFor(cliJs, stagingRef, tables);
const liveProductionTableCounts = countsFor(cliJs, productionRef, tables);
const stagingCollections = collectionCounts(cliJs, stagingRef);
const liveProductionCollections = collectionCounts(cliJs, productionRef);

const snapshotTableDifferences = tables.filter((table) => snapshotTableCounts[table] !== stagingTableCounts[table]);
const snapshotCollectionNames = [...new Set([...Object.keys(snapshotCollections), ...Object.keys(stagingCollections)])].sort();
const snapshotCollectionDifferences = snapshotCollectionNames.filter((name) => snapshotCollections[name] !== stagingCollections[name]);
const liveTableDifferences = tables.filter((table) => liveProductionTableCounts[table] !== stagingTableCounts[table]);
const liveCollectionNames = [...new Set([...Object.keys(liveProductionCollections), ...Object.keys(stagingCollections)])].sort();
const liveCollectionDifferences = liveCollectionNames.filter((name) => liveProductionCollections[name] !== stagingCollections[name]);

const snapshotSchema = {
  policies: backup.schemaInventory.policies,
  functions: backup.schemaInventory.functions,
  triggers: backup.schemaInventory.triggers,
  extensions: backup.schemaInventory.extensions,
  migrations: backup.migrationState.map((migration) => ({ version: migration.version, name: migration.name })),
};
const stagingSchema = schemaInventory(cliJs, stagingRef);
const productionSchema = schemaInventory(cliJs, productionRef);
const schemaParity = Object.fromEntries(Object.keys(snapshotSchema).map((kind) => [kind, {
  snapshot_count: snapshotSchema[kind].length,
  staging_count: stagingSchema[kind].length,
  exact_hash_match: hash(normalizeInventory(kind, snapshotSchema[kind])) === hash(normalizeInventory(kind, stagingSchema[kind])),
  live_production_count: productionSchema[kind].length,
  live_production_hash_matches_staging: hash(normalizeInventory(kind, productionSchema[kind])) === hash(normalizeInventory(kind, stagingSchema[kind])),
}]));

const stagingRuntime = query(cliJs, stagingRef, `
  select current_setting('server_version') as server_version,current_setting('TimeZone') as timezone,
    (select count(*)::bigint from auth.users) as auth_users,
    (select count(*)::bigint from auth.users where raw_app_meta_data @> '{"staging_placeholder":true}'::jsonb) as placeholder_users,
    (select count(*)::bigint from auth.identities) as auth_identities,
    (select count(*)::bigint from auth.sessions) as auth_sessions,
    (select count(*)::bigint from storage.buckets) as storage_buckets,
    (select count(*)::bigint from storage.objects) as storage_objects
`)[0];
const productionRuntime = query(cliJs, productionRef, `
  select current_setting('server_version') as server_version,current_setting('TimeZone') as timezone,
    (select count(*)::bigint from auth.users) as auth_users,
    (select count(*)::bigint from auth.identities) as auth_identities,
    (select count(*)::bigint from auth.sessions) as auth_sessions,
    (select count(*)::bigint from storage.buckets) as storage_buckets,
    (select count(*)::bigint from storage.objects) as storage_objects
`)[0];

const productionEdge = edgeFunctions(cliJs, productionRef);
const stagingEdge = edgeFunctions(cliJs, stagingRef);
const required = ['clients','employees','_accounts','candidates','tasks','contracts','invoices','payments'];
const financeNames = ['employeePayments','expenses','fixedCosts','partnerSettlements','payments','invoices'];
const businessComparison = Object.fromEntries(required.map((name) => [name === 'candidates' ? 'applicants/candidates' : name, {
  snapshot: Number(snapshotCollections[name] || 0),
  staging: Number(stagingCollections[name] || 0),
  live_production: Number(liveProductionCollections[name] || 0),
}]));
businessComparison.finance_total = {
  snapshot: sumCollections(snapshotCollections, financeNames),
  staging: sumCollections(stagingCollections, financeNames),
  live_production: sumCollections(liveProductionCollections, financeNames),
};

const report = {
  format: 'magnet-os-m0-staging-validation',
  created_at: new Date().toISOString(),
  production: { name: production.name, ref: productionRef, status: production.status },
  staging: { name: staging.name, ref: stagingRef, status: staging.status },
  snapshot: { created_at: backup.completedAt, public_tables: tables.length, records: snapshotTableCounts.records, collections: Object.keys(snapshotCollections).length },
  snapshot_vs_staging: {
    exact_table_counts: snapshotTableDifferences.length === 0,
    table_count_differences: snapshotTableDifferences.map((name) => ({ name, snapshot: snapshotTableCounts[name], staging: stagingTableCounts[name] })),
    exact_collection_counts: snapshotCollectionDifferences.length === 0,
    collection_count_differences: snapshotCollectionDifferences.map((name) => ({ name, snapshot: snapshotCollections[name] || 0, staging: stagingCollections[name] || 0 })),
    business_counts: businessComparison,
    schema_parity: schemaParity,
    edge_functions: { production: productionEdge, staging: stagingEdge, matching_names_and_jwt: hash(productionEdge) === hash(stagingEdge) },
    auth: {
      production_inventory_users: Number(backup.authInventory.counts.users),
      staging_placeholder_users: Number(stagingRuntime.placeholder_users),
      staging_identities: Number(stagingRuntime.auth_identities),
      staging_sessions: Number(stagingRuntime.auth_sessions),
      credentials_copied: false,
    },
    storage: {
      snapshot_buckets: backup.storageInventory.buckets.length,
      staging_buckets: Number(stagingRuntime.storage_buckets),
      snapshot_objects: backup.storageInventory.objects.length,
      staging_objects: Number(stagingRuntime.storage_objects),
    },
  },
  live_production_vs_staging_after_snapshot: {
    note: 'Production is active. Differences here are expected if users wrote data after the snapshot; the restore gate is snapshot_vs_staging.',
    table_count_differences: liveTableDifferences.map((name) => ({ name, live_production: liveProductionTableCounts[name], staging: stagingTableCounts[name] })),
    collection_count_differences: liveCollectionDifferences.map((name) => ({ name, live_production: liveProductionCollections[name] || 0, staging: stagingCollections[name] || 0 })),
  },
  runtime: { production: productionRuntime, staging: stagingRuntime },
  pass: snapshotTableDifferences.length === 0 && snapshotCollectionDifferences.length === 0 &&
    Number(stagingRuntime.placeholder_users) === Number(backup.authInventory.counts.users) &&
    Number(stagingRuntime.storage_objects) === backup.storageInventory.objects.length,
};

const reportFile = path.join(backupDir, 'staging-difference-report.json');
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportFile, 0o600);

console.log(`Staging validation: ${report.pass ? 'PASS' : 'FAIL'}`);
console.log(`Snapshot table counts exact: ${report.snapshot_vs_staging.exact_table_counts}`);
console.log(`Snapshot collection counts exact: ${report.snapshot_vs_staging.exact_collection_counts}`);
console.log(`Schema parity checks: ${Object.entries(schemaParity).map(([name, value]) => `${name}=${value.exact_hash_match}`).join(', ')}`);
console.log(`Live Production drifted tables after snapshot: ${liveTableDifferences.length}`);
console.log(`Live Production drifted collections after snapshot: ${liveCollectionDifferences.length}`);
console.log(`Private report: ${reportFile}`);
if (!report.pass) process.exit(1);
