#!/usr/bin/env node
'use strict';

/**
 * M0 logical Supabase backup through the authenticated Management API.
 *
 * This is intentionally read-only. It never sends INSERT/UPDATE/DELETE/DDL to
 * the remote project. The output directory must live under the gitignored
 * backups/ directory and is created with owner-only permissions.
 *
 * Usage:
 *   node tools/m0-logical-backup.js \
 *     --project-ref=<ref> \
 *     --out-dir=<absolute-directory> \
 *     --cli-js=<absolute-path-to-supabase.js>
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value, spacing = 0) {
  return JSON.stringify(canonical(value), null, spacing);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const args = parseArgs(process.argv);
const projectRef = String(args['project-ref'] || '').trim();
const outDir = path.resolve(String(args['out-dir'] || ''));
const cliJs = args['cli-js'] ? path.resolve(String(args['cli-js'])) : '';
const cliBin = args['cli-bin'] ? path.resolve(String(args['cli-bin'])) : '';

if (!/^[a-z]{20}$/.test(projectRef)) {
  console.error('ERROR: --project-ref must be a 20-character Supabase project ref.');
  process.exit(2);
}
if (!args['out-dir'] || !outDir.includes(`${path.sep}backups${path.sep}`)) {
  console.error('ERROR: --out-dir must be an explicit directory under backups/.');
  process.exit(2);
}
if ((!cliJs || !fs.existsSync(cliJs)) && (!cliBin || !fs.existsSync(cliBin))) {
  console.error('ERROR: supply either --cli-js or --cli-bin pointing to an installed Supabase CLI.');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.chmodSync(outDir, 0o700);

function query(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) {
    throw new Error('Backup query rejected because it is not read-only SELECT/WITH SQL.');
  }
  const executable = cliBin || process.execPath;
  const prefix = cliBin ? [] : [cliJs];
  const result = spawnSync(executable, [
    ...prefix,
    'db', 'query',
    '--linked',
    '--project-ref', projectRef,
    '--output', 'json',
    sql,
  ], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`Supabase query failed: ${safeError(result.stderr || result.stdout)}`);
  }
  const stdout = String(result.stdout || '');
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`Supabase query returned no JSON: ${safeError(stdout)}`);
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (error) {
    throw new Error(`Could not parse Supabase query JSON: ${safeError(error.message)}`);
  }
  if (!Array.isArray(parsed.rows)) throw new Error('Supabase query response has no rows array.');
  return parsed.rows;
}

const startedAt = new Date().toISOString();

const project = query(`
  select
    current_database() as database_name,
    current_setting('server_version') as server_version,
    current_setting('TimeZone') as timezone,
    pg_database_size(current_database()) as database_bytes,
    now() as captured_at
`)[0];

const relations = query(`
  select
    n.nspname as schema_name,
    c.relname as relation_name,
    c.relkind as relation_kind,
    c.relrowsecurity as rls_enabled,
    c.relforcerowsecurity as force_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','auth','storage','supabase_migrations')
    and c.relkind in ('r','p','v','m')
  order by 1,2
`);

const publicTables = relations
  .filter((row) => row.schema_name === 'public' && ['r', 'p'].includes(row.relation_kind))
  .map((row) => row.relation_name);

const publicData = {};
for (const table of publicTables) {
  const rows = query(`select to_jsonb(t) as row from public.${quoteIdent(table)} t`)
    .map((entry) => entry.row);
  rows.sort((a, b) => {
    const aKey = a && (a.id ?? a.version ?? a.name);
    const bKey = b && (b.id ?? b.version ?? b.name);
    return String(aKey ?? stableStringify(a)).localeCompare(String(bKey ?? stableStringify(b)));
  });
  publicData[table] = rows;
}

const collections = query(`
  select coll, count(*)::bigint as row_count
  from public.records
  group by coll
  order by coll
`);

const schemaInventory = {
  relations,
  enums: query(`
    select n.nspname as schema_name, t.typname as type_name,
           jsonb_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_namespace n on n.oid=t.typnamespace
    join pg_enum e on e.enumtypid=t.oid
    where n.nspname='public'
    group by n.nspname,t.typname
    order by 1,2
  `),
  columns: query(`
    select n.nspname as schema_name,c.relname as table_name,a.attnum as ordinal_position,
           a.attname as column_name,format_type(a.atttypid,a.atttypmod) as data_type,
           a.attnotnull as not_null,a.attidentity as identity_kind,a.attgenerated as generated_kind,
           pg_get_expr(d.adbin,d.adrelid) as default_expression
    from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
    order by 1,2,3
  `),
  constraints: query(`
    select n.nspname as schema_name,c.relname as table_name,con.conname as constraint_name,
           con.contype as constraint_type,pg_get_constraintdef(con.oid,true) as definition
    from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
    order by 1,2,3
  `),
  indexes: query(`
    select schemaname as schema_name,tablename as table_name,indexname as index_name,indexdef as definition
    from pg_indexes where schemaname='public' order by tablename,indexname
  `),
  views: query(`
    select n.nspname as schema_name,c.relname as view_name,c.relkind as view_kind,
           pg_get_viewdef(c.oid,true) as definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('v','m')
    order by 1,2
  `),
  functions: query(`
    select n.nspname as schema_name,p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as identity_arguments,
           p.prosecdef as security_definer,p.proacl as acl,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
    order by 1,2,3
  `),
  triggers: query(`
    select n.nspname as schema_name,c.relname as table_name,t.tgname as trigger_name,
           pg_get_triggerdef(t.oid,true) as definition,t.tgenabled as enabled
    from pg_trigger t
    join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal
    order by 1,2,3
  `),
  policies: query(`
    select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
    from pg_policies where schemaname in ('public','storage')
    order by schemaname,tablename,policyname
  `),
  extensions: query(`
    select e.extname as extension_name,e.extversion as version,n.nspname as schema_name
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
    order by e.extname
  `),
  grants: query(`
    select grantee,table_schema,table_name,privilege_type,is_grantable
    from information_schema.role_table_grants
    where table_schema='public'
    order by table_name,grantee,privilege_type
  `),
};

const authInventory = {
  counts: query(`
    select
      (select count(*)::bigint from auth.users) as users,
      (select count(*)::bigint from auth.identities) as identities,
      (select count(*)::bigint from auth.sessions) as sessions,
      (select count(*)::bigint from auth.mfa_factors) as mfa_factors
  `)[0],
  users: query(`
    select id,aud,role,email,email_confirmed_at,created_at,updated_at,last_sign_in_at,
           banned_until,deleted_at,is_anonymous,raw_app_meta_data,raw_user_meta_data
    from auth.users order by created_at,id
  `),
  identities: query(`
    select id,user_id,provider,provider_id,created_at,updated_at,last_sign_in_at
    from auth.identities order by created_at,id
  `),
  note: 'Inventory intentionally excludes password hashes, OTPs, refresh tokens, sessions and recovery secrets.',
};

const storageInventory = {
  buckets: query(`
    select id,name,public,file_size_limit,allowed_mime_types,created_at,updated_at
    from storage.buckets order by id
  `),
  objects: query(`
    select id,bucket_id,name,owner,created_at,updated_at,last_accessed_at,metadata
    from storage.objects order by bucket_id,name
  `),
};

const migrationState = query(`
  select to_jsonb(m) as migration
  from supabase_migrations.schema_migrations m
  order by version
`).map((row) => row.migration);

const logicalBackup = {
  format: 'magnet-os-m0-logical-backup',
  version: 1,
  sourceProjectRef: projectRef,
  startedAt,
  completedAt: new Date().toISOString(),
  project,
  collections,
  publicData,
  authInventory,
  storageInventory,
  migrationState,
  schemaInventory,
};

const records = publicData.records || [];
const accountCount = records.filter((row) => row && row.coll === '_accounts').length;
const tableCounts = Object.fromEntries(Object.entries(publicData).map(([name, rows]) => [name, rows.length]));
const manifest = {
  format: logicalBackup.format,
  version: logicalBackup.version,
  sourceProjectRef: projectRef,
  createdAt: logicalBackup.completedAt,
  databaseVersion: project.server_version,
  databaseBytes: project.database_bytes,
  publicTableCounts: tableCounts,
  collectionCounts: Object.fromEntries(collections.map((row) => [row.coll, Number(row.row_count)])),
  includesAccounts: accountCount > 0,
  accountCount,
  authCounts: authInventory.counts,
  storageBuckets: storageInventory.buckets.length,
  storageObjects: storageInventory.objects.length,
  appliedMigrations: migrationState.length,
};

const files = {
  'logical-backup.json': stableStringify(logicalBackup, 2) + '\n',
  'manifest.json': stableStringify(manifest, 2) + '\n',
  'schema-inventory.json': stableStringify(schemaInventory, 2) + '\n',
  'auth-inventory.json': stableStringify(authInventory, 2) + '\n',
  'storage-inventory.json': stableStringify(storageInventory, 2) + '\n',
  'migration-state.json': stableStringify(migrationState, 2) + '\n',
};

const checksumLines = [];
for (const [name, content] of Object.entries(files)) {
  const file = path.join(outDir, name);
  writePrivate(file, content);
  checksumLines.push(`${sha256(Buffer.from(content))}  ${name}`);
}
writePrivate(path.join(outDir, 'checksums.sha256'), checksumLines.join('\n') + '\n');

console.log(`M0 logical backup created: ${outDir}`);
console.log(`Public tables: ${publicTables.length}`);
console.log(`Records: ${records.length}`);
console.log(`Collections: ${collections.length}`);
console.log(`_accounts: ${accountCount}`);
console.log(`Auth users inventoried: ${authInventory.counts.users}`);
console.log(`Storage objects inventoried: ${storageInventory.objects.length}`);
console.log(`Applied migrations: ${migrationState.length}`);
console.log(`Manifest SHA-256: ${sha256(Buffer.from(files['manifest.json']))}`);
