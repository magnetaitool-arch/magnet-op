#!/usr/bin/env node
'use strict';

/**
 * Data-only cutover from a verified legacy Production snapshot into the
 * already-migrated MAGNET OS V2 project. Schema and migration history are not
 * copied. Existing target-only rows are soft-deleted, never hard-deleted.
 *
 * Dry-run is the default. --apply is required for any remote mutation.
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
    .slice(-5000);
}

function commandJson(cliBin, cliArgs) {
  const result = spawnSync(cliBin, cliArgs, {
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

function query(cliBin, projectRef, sql) {
  const payload = commandJson(cliBin, [
    'db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql,
  ]);
  if (!Array.isArray(payload.rows)) throw new Error('Query response has no rows array.');
  return payload.rows;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function normalizeData(coll, value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (coll === '_accounts') delete data.serverUpdatedAt;
  return canonical(data);
}

function isDeleted(row) {
  const flag = String(row && row.data && row.data._del || '').toLowerCase();
  return Boolean(row && row.deleted_at) || ['true', '1', 't'].includes(flag);
}

function comparable(row) {
  return JSON.stringify(canonical({
    id: row.id,
    coll: row.coll,
    data: normalizeData(row.coll, row.data),
    deleted: isDeleted(row),
  }));
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dollarJson(value) {
  const json = JSON.stringify(value);
  const tag = `cutover${crypto.createHash('sha256').update(json).digest('hex').slice(0, 12)}`;
  return `$${tag}$${json}$${tag}$::jsonb`;
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const args = parseArgs(process.argv);
const productionRef = String(args['production-ref'] || '').trim();
const targetRef = String(args['target-ref'] || '').trim();
const expectedTargetName = String(args['expected-target-name'] || 'MAGNET OS STAGING');
const backupDir = path.resolve(String(args['backup-dir'] || ''));
const rollbackBackupDir = path.resolve(String(args['rollback-backup-dir'] || ''));
const cliBin = path.resolve(String(args['cli-bin'] || ''));
const apply = Boolean(args.apply);

if (!/^[a-z]{20}$/.test(productionRef) || !/^[a-z]{20}$/.test(targetRef) || productionRef === targetRef) {
  console.error('REFUSED: explicit and different Production/target project refs are required.');
  process.exit(2);
}
if (!backupDir.includes(`${path.sep}backups${path.sep}`) || !rollbackBackupDir.includes(`${path.sep}backups${path.sep}`)) {
  console.error('REFUSED: source and rollback backups must be explicit directories under backups/.');
  process.exit(2);
}
if (!fs.existsSync(cliBin)) {
  console.error('REFUSED: --cli-bin must point to the installed Supabase CLI executable.');
  process.exit(2);
}

const sourceFile = path.join(backupDir, 'logical-backup.json');
const rollbackFile = path.join(rollbackBackupDir, 'logical-backup.json');
const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const rollback = JSON.parse(fs.readFileSync(rollbackFile, 'utf8'));
if (source.format !== 'magnet-os-m0-logical-backup' || source.sourceProjectRef !== productionRef) {
  console.error('REFUSED: source snapshot identity does not match Production.');
  process.exit(2);
}
if (rollback.format !== 'magnet-os-m0-logical-backup' || rollback.sourceProjectRef !== targetRef) {
  console.error('REFUSED: rollback snapshot identity does not match the target project.');
  process.exit(2);
}

const projectsPayload = commandJson(cliBin, ['projects', 'list', '--output', 'json']);
const projects = Array.isArray(projectsPayload) ? projectsPayload : projectsPayload.projects;
const productionProject = projects.find((item) => (item.ref || item.id) === productionRef);
const targetProject = projects.find((item) => (item.ref || item.id) === targetRef);
if (!productionProject || !targetProject || targetProject.name !== expectedTargetName || targetProject.status !== 'ACTIVE_HEALTHY') {
  console.error('REFUSED: target is missing, unhealthy, or has the wrong safety name.');
  process.exit(2);
}
if (productionProject.organization_id === targetProject.organization_id) {
  console.error('REFUSED: target shares the restricted Production organization.');
  process.exit(2);
}

const targetMeta = query(cliBin, targetRef, `
  select
    (select count(*)::bigint from supabase_migrations.schema_migrations) as migration_count,
    (select count(*)::bigint from public.organizations) as organization_count,
    (select id from public.organizations where slug='magnet' limit 1) as organization_id
`)[0];
if (Number(targetMeta.migration_count) < 38 || Number(targetMeta.organization_count) !== 1 || !targetMeta.organization_id) {
  console.error('REFUSED: target is not the validated single-tenant MAGNET OS V2 schema.');
  process.exit(2);
}
const organizationId = targetMeta.organization_id;

const ignoredCollections = new Set(['_config', '_ratelimit']);
const sourceRows = (source.publicData.records || []).filter((row) => !ignoredCollections.has(row.coll));
const sourceCollections = [...new Set(sourceRows.map((row) => row.coll))].sort();
const targetRows = query(cliBin, targetRef, `
  select id,coll,data,created_at,created_by,updated_by,deleted_at,organization_id
  from public.records
  where organization_id=${quoteLiteral(organizationId)}::uuid
    and coll not in ('_config','_ratelimit')
  order by id
`);

const sourceMap = new Map(sourceRows.map((row) => [row.id, row]));
const targetMap = new Map(targetRows.map((row) => [row.id, row]));
let creates = 0;
let updates = 0;
let unchanged = 0;
for (const [id, row] of sourceMap) {
  const current = targetMap.get(id);
  if (!current) creates += 1;
  else if (comparable(current) === comparable(row)) unchanged += 1;
  else updates += 1;
}
const targetOnlyActive = targetRows.filter((row) => !sourceMap.has(row.id) && !isDeleted(row));
const countByCollection = (rows) => Object.fromEntries([...rows.reduce((map, row) => {
  map.set(row.coll, (map.get(row.coll) || 0) + 1);
  return map;
}, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b)));
const createRows = sourceRows.filter((row) => !targetMap.has(row.id));
const updateRows = sourceRows.filter((row) => targetMap.has(row.id) && comparable(targetMap.get(row.id)) !== comparable(row));
const mutationIds = [...createRows, ...updateRows].map((row) => row.id);

console.log(`Verified target: ${targetProject.name} (${targetRef})`);
console.log(`V2 migrations: ${targetMeta.migration_count}`);
console.log(`Source business/account records: ${sourceRows.length}`);
console.log(`Creates: ${creates}`);
console.log(`Updates: ${updates}`);
console.log(`Unchanged: ${unchanged}`);
console.log(`Target-only active rows to soft-delete: ${targetOnlyActive.length}`);
console.log(`Creates by collection: ${JSON.stringify(countByCollection(createRows))}`);
console.log(`Updates by collection: ${JSON.stringify(countByCollection(updateRows))}`);
console.log(`Soft-deletes by collection: ${JSON.stringify(countByCollection(targetOnlyActive))}`);
console.log('Preserved target-only system collections: _config, _ratelimit');

const rowsWithTenant = sourceRows.map((row) => ({ ...row, organization_id: organizationId }));
const statements = [
  'BEGIN;',
  "SET LOCAL statement_timeout = '0';",
  "SET LOCAL lock_timeout = '15s';",
  'CREATE TEMP TABLE cutover_source_records (LIKE public.records INCLUDING DEFAULTS) ON COMMIT DROP;',
  'CREATE TEMP TABLE cutover_mutation_ids (id text PRIMARY KEY) ON COMMIT DROP;',
];
for (let index = 0; index < rowsWithTenant.length; index += 100) {
  const chunk = rowsWithTenant.slice(index, index + 100);
  statements.push(`
    INSERT INTO cutover_source_records
    SELECT * FROM jsonb_populate_recordset(NULL::public.records, ${dollarJson(chunk)});
  `);
}
statements.push(`
  INSERT INTO cutover_mutation_ids(id)
  SELECT value FROM jsonb_array_elements_text(${dollarJson(mutationIds)});
`);
statements.push(`
  DO $$ BEGIN
    IF (SELECT count(*) FROM cutover_source_records) <> ${sourceRows.length} THEN
      RAISE EXCEPTION 'cutover_source_count_mismatch';
    END IF;
    IF (SELECT count(*) FROM cutover_mutation_ids) <> ${mutationIds.length} THEN
      RAISE EXCEPTION 'cutover_mutation_count_mismatch';
    END IF;
  END $$;
`);

const precedence = [
  '_accounts', 'employees', 'clients', 'projects', 'leads', 'candidates',
  'contracts', 'invoices', 'payments', 'tasks', 'notifications', 'activityLogs',
];
const orderedCollections = [...precedence.filter((coll) => sourceCollections.includes(coll)), ...sourceCollections.filter((coll) => !precedence.includes(coll))];
for (const coll of orderedCollections) {
  statements.push(`
    INSERT INTO public.records
      (id,coll,data,updated_at,created_at,created_by,updated_by,deleted_at,organization_id)
    SELECT source.id,source.coll,source.data,source.updated_at,source.created_at,source.created_by,
           source.updated_by,source.deleted_at,source.organization_id
    FROM cutover_source_records source
    JOIN cutover_mutation_ids mutation ON mutation.id=source.id
    WHERE source.coll=${quoteLiteral(coll)} ORDER BY source.id
    ON CONFLICT (id) DO UPDATE SET
      coll=excluded.coll,
      data=excluded.data,
      updated_at=excluded.updated_at,
      created_at=excluded.created_at,
      created_by=excluded.created_by,
      updated_by=excluded.updated_by,
      deleted_at=excluded.deleted_at,
      organization_id=excluded.organization_id
    WHERE public.records.coll IS DISTINCT FROM excluded.coll
       OR (case when excluded.coll='_accounts' then public.records.data-'serverUpdatedAt' else public.records.data end)
          IS DISTINCT FROM
          (case when excluded.coll='_accounts' then excluded.data-'serverUpdatedAt' else excluded.data end)
       OR (public.records.deleted_at is not null) IS DISTINCT FROM (excluded.deleted_at is not null)
       OR public.records.organization_id IS DISTINCT FROM excluded.organization_id;
  `);
}
statements.push(`
  UPDATE public.records record
  SET data=jsonb_set(coalesce(record.data,'{}'::jsonb),'{_del}','true'::jsonb,true),
      deleted_at=coalesce(record.deleted_at,now())
  WHERE record.organization_id=${quoteLiteral(organizationId)}::uuid
    AND record.coll=ANY(${quoteLiteral(`{${sourceCollections.join(',')}}`)}::text[])
    AND record.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM cutover_source_records source WHERE source.id=record.id);
`);
statements.push('COMMIT;');

const sqlFile = path.join(backupDir, 'cutover-sync-v2.sql');
writePrivate(sqlFile, statements.join('\n\n') + '\n');
console.log(`Cutover SQL: ${sqlFile}`);

if (!apply) {
  console.log('DRY-RUN complete — target was not changed.');
  process.exit(0);
}

const applyResult = spawnSync(cliBin, [
  'db', 'query', '--linked', '--project-ref', targetRef, '--file', sqlFile, '--output', 'json',
], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
});
if (applyResult.status !== 0) {
  console.error(`CUTOVER FAILED — transaction rolled back: ${safeError(applyResult.stderr || applyResult.stdout)}`);
  process.exit(1);
}

const afterRows = query(cliBin, targetRef, `
  select id,coll,data,created_at,created_by,updated_by,deleted_at,organization_id
  from public.records
  where organization_id=${quoteLiteral(organizationId)}::uuid
    and coll not in ('_config','_ratelimit')
  order by id
`);
const afterMap = new Map(afterRows.map((row) => [row.id, row]));
const missing = [];
const mismatched = [];
for (const [id, row] of sourceMap) {
  const restored = afterMap.get(id);
  if (!restored) missing.push(id);
  else if (comparable(restored) !== comparable(row)) mismatched.push(id);
}
const activeTargetOnly = afterRows.filter((row) => !sourceMap.has(row.id) && !isDeleted(row));
const sourceActiveCounts = {};
for (const row of sourceRows) if (!isDeleted(row)) sourceActiveCounts[row.coll] = (sourceActiveCounts[row.coll] || 0) + 1;
const targetActiveCounts = {};
for (const row of afterRows) if (!isDeleted(row)) targetActiveCounts[row.coll] = (targetActiveCounts[row.coll] || 0) + 1;
const countDifferences = sourceCollections.filter((coll) => Number(sourceActiveCounts[coll] || 0) !== Number(targetActiveCounts[coll] || 0));

const report = {
  format: 'magnet-os-v2-cutover-sync-report',
  createdAt: new Date().toISOString(),
  productionRef,
  targetRef,
  sourceBackup: backupDir,
  rollbackBackup: rollbackBackupDir,
  sourceRecords: sourceRows.length,
  targetRecordsAfter: afterRows.length,
  creates,
  updates,
  unchanged,
  softDeletedTargetOnly: targetOnlyActive.length,
  missingSourceIds: missing,
  mismatchedSourceIds: mismatched,
  activeTargetOnlyIds: activeTargetOnly.map((row) => row.id),
  activeCountDifferences: countDifferences,
  sourceActiveCounts,
  targetActiveCounts,
};
const reportFile = path.join(backupDir, 'cutover-sync-report.json');
writePrivate(reportFile, JSON.stringify(report, null, 2) + '\n');
writePrivate(`${reportFile}.sha256`, `${crypto.createHash('sha256').update(fs.readFileSync(reportFile)).digest('hex')}  ${path.basename(reportFile)}\n`);

if (missing.length || mismatched.length || activeTargetOnly.length || countDifferences.length) {
  console.error(`CUTOVER VALIDATION FAILED — missing=${missing.length}, mismatched=${mismatched.length}, activeTargetOnly=${activeTargetOnly.length}, countDifferences=${countDifferences.length}`);
  process.exit(1);
}
console.log(`CUTOVER DATA SYNC PASSED — ${sourceRows.length} source rows validated; ${targetOnlyActive.length} target-only rows soft-deleted.`);
console.log(`Validation report: ${reportFile}`);
