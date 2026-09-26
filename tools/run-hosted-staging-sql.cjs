'use strict';
// Reuse the existing SQL behavioral suite on the explicitly isolated hosted project.
// The generated harness contains no credentials and never restarts hosted services.
const fs = require('node:fs'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  source = fs.readFileSync(path.join(__dirname, 'database-test.mjs'), 'utf8');
const imports = source
  .split('\n')
  .filter((l) => /^import.*from '\.\//.test(l))
  .map((l) =>
    l.replace(
      /from '(\.\/[^']+)'/,
      (_, p) => 'from ' + JSON.stringify(pathToFileURL(path.resolve(__dirname, p)).href),
    ),
  )
  .join('\n');
const start = source.indexOf("  current = 'authorization behavior';"),
  end = source.indexOf('  const persistedClientCount =');
if (start < 0 || end < start) throw new Error('Existing SQL harness boundaries changed');
let body = source.slice(start, end);
body = body.replace(
  '(await client.query("select id from organizations where slug=\'magnet\'")).rows[0].id',
  "(await client.query(\"insert into organizations(name,slug) values ('Hosted SQL QA','hosted-sql-qa-a') returning id\")).rows[0].id",
);
body = body.replace("'Synthetic second tenant','test-b'", "'Hosted SQL QA B','hosted-sql-qa-b'");
body = body.replace(
  "client.query('select count(*)::int as n from client_accounts')",
  "client.query(\"select count(*)::int as n from client_accounts where legacy_record_id in ('test-client-a','test-client-b')\")",
);
body = body.replace(
  "assert.equal((await client.query('select * from client_accounts')).rowCount, 2)",
  "assert.equal((await client.query(\"select * from client_accounts where legacy_record_id in ('test-client-a','test-client-b')\")).rowCount, 2)",
);
const header = `import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(path.join(root, 'package.json'))});const {Client}=createRequire(require.resolve('embedded-postgres'))('pg');
const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.config/magnet-os/release-staging.json')));assert.equal(cfg.project_ref,'vsurqqbxjvqzvqbmetjw');
const p=cfg.pooler[0];assert.ok(p.db_user.endsWith('.'+cfg.project_ref));const options={host:p.db_host,port:5432,user:p.db_user,database:p.db_name,password:cfg.db_password,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(path.join(os.homedir(),'.config/magnet-os/supabase-ca.crt'))}};
const database={getPgClient:()=>new Client(options)};let client=database.getPgClient();let current='hosted SQL setup';await client.connect();
try {assert.equal((await client.query("select count(*)::int n from supabase_migrations.schema_migrations")).rows[0].n,48);
`;
const out = path.join(root, 'tmp/hosted-staging-sql.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  imports +
    '\n' +
    header +
    body +
    "\nconsole.log('PASS hosted SQL workflow/permission/concurrency suite');}finally{await client.end();}\n",
  { mode: 0o600 },
);
const result = spawnSync(process.execPath, [out], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
