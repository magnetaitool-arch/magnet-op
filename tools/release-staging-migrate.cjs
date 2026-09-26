'use strict';
// Explicitly restricted to the independently created release staging project.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { Client } = createRequire(require.resolve('embedded-postgres'))('pg');
const REF = 'vsurqqbxjvqzvqbmetjw';
const configPath = path.join(os.homedir(), '.config/magnet-os/release-staging.json');
const config = JSON.parse(fs.readFileSync(configPath));
if (config.project_ref !== REF || !config.pooler[0].db_user.endsWith('.' + REF))
  throw new Error('Staging identity mismatch');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'backups/release-staging-20260926');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pool = config.pooler[0];
const ca = path.join(path.dirname(configPath), 'supabase-ca.crt');
const client = new Client({
  host: pool.db_host,
  port: 5432,
  user: pool.db_user,
  database: pool.db_name,
  password: config.db_password,
  ssl: { rejectUnauthorized: true, ca: fs.readFileSync(ca) },
  connectionTimeoutMillis: 15000,
});
const cli = process.env.MAGNET_SUPABASE_CLI;
if (!cli) throw new Error('MAGNET_SUPABASE_CLI required');
const work = path.join(path.dirname(configPath), 'migration-workdir');
const migrationsDir = path.join(work, 'supabase/migrations');
fs.mkdirSync(migrationsDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(work, 'supabase/config.toml'),
  'project_id = "magnet-release-staging"\n',
);
const url = new URL('postgresql://' + pool.db_host + ':5432/' + pool.db_name);
url.username = pool.db_user;
url.password = config.db_password;
url.searchParams.set('sslmode', 'verify-full');
url.searchParams.set('sslrootcert', ca);
const files = fs
  .readdirSync(path.join(root, 'supabase/migrations'))
  .filter((n) => n.endsWith('.sql') && n >= '20260816101341')
  .sort();
const record = (name, value) =>
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
async function snapshot(name) {
  const tables = (
    await client.query(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
  ).rows;
  const counts = {};
  if (tables.length) {
    const sql = tables
      .map(
        ({ tablename }) =>
          "select '" +
          tablename.replaceAll("'", "''") +
          '\' name,count(*)::int n from public."' +
          tablename.replaceAll('"', '""') +
          '\"',
      )
      .join(' union all ');
    for (const row of (await client.query(sql)).rows) counts[row.name] = row.n;
  }
  record(name, {
    project: REF,
    at: new Date().toISOString(),
    counts,
    constraints: (
      await client.query(
        "select conname,pg_get_constraintdef(oid) definition from pg_constraint where connamespace='public'::regnamespace order by conname",
      )
    ).rows,
    policies: (
      await client.query(
        "select * from pg_policies where schemaname in ('public','storage') order by schemaname,tablename,policyname",
      )
    ).rows,
    indexes: (
      await client.query(
        "select indexname,indexdef from pg_indexes where schemaname='public' order by indexname",
      )
    ).rows,
  });
  return counts;
}
(async () => {
  await client.connect();
  try {
    if (!fs.existsSync(path.join(output, 'empty-baseline.json'))) await snapshot('empty-baseline');
    const present = (await client.query("select to_regclass('public.records') found")).rows[0]
      .found;
    if (!present) {
      if (!process.argv.includes('--apply'))
        throw new Error('Use --apply for staging baseline and migrations');
      await client.query(
        fs.readFileSync(path.join(root, 'tools/fixtures/legacy-schema.sql'), 'utf8'),
      );
      console.log('Installed schema-only legacy baseline on independent staging');
    }
    for (const name of files) {
      const version = name.split('_')[0];
      const ledgerExists = (
        await client.query("select to_regclass('supabase_migrations.schema_migrations') found")
      ).rows[0].found;
      if (
        ledgerExists &&
        (
          await client.query(
            'select 1 from supabase_migrations.schema_migrations where version=$1',
            [version],
          )
        ).rowCount
      ) {
        const target = path.join(migrationsDir, name);
        if (!fs.existsSync(target))
          fs.copyFileSync(path.join(root, 'supabase/migrations', name), target);
        continue;
      }
      if (!process.argv.includes('--apply')) throw new Error('Pending migration: ' + name);
      if (version === '20260825170000')
        await client.query(
          "insert into public.organizations(name,slug) values ('Magnet Release QA','magnet') on conflict do nothing",
        );
      const before = await snapshot('before-' + version);
      fs.copyFileSync(path.join(root, 'supabase/migrations', name), path.join(migrationsDir, name));
      const result = spawnSync(
        cli,
        ['db', 'push', '--workdir', work, '--db-url', url.toString(), '--include-all', '--yes'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
      );
      const safe = (result.stdout + '\n' + result.stderr)
        .split(config.db_password)
        .join('[REDACTED]')
        .split(url.toString())
        .join('[REDACTED_DB_URL]');
      fs.writeFileSync(path.join(output, version + '.log'), safe, { mode: 0o600 });
      if (result.status !== 0) {
        console.error(safe.slice(-2500));
        throw new Error('Stopped at ' + name);
      }
      const applied = (
        await client.query('select 1 from supabase_migrations.schema_migrations where version=$1', [
          version,
        ])
      ).rowCount;
      if (!applied) throw new Error('Missing migration ledger entry ' + version);
      const after = await snapshot('after-' + version);
      const losses = Object.keys(before).filter(
        (t) => t !== 'schema_migrations' && (after[t] === undefined || after[t] < before[t]),
      );
      if (losses.length) throw new Error('Unexpected count reduction: ' + losses.join(','));
      console.log('PASS migration + ledger + counts:', name);
    }
    record(
      'applied-manifest',
      files.map((name) => ({
        name,
        sha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, 'supabase/migrations', name)))
          .digest('hex'),
      })),
    );
    console.log(
      'PASS all ' +
        files.length +
        ' canonical migrations on isolated hosted staging; workflow verification still required',
    );
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
