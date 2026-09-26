import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { Client } = createRequire(require.resolve('embedded-postgres'))('pg');
const privatePath = path.join(os.homedir(), '.config/magnet-os/release-staging.json');
const cfg = JSON.parse(fs.readFileSync(privatePath));
assert.equal(cfg.project_ref, 'vsurqqbxjvqzvqbmetjw');
const p = cfg.pooler[0],
  base = `https://${cfg.project_ref}.supabase.co`;
const anon = cfg.api_keys.find((k) => k.name === 'anon').api_key;
const db = new Client({
  host: p.db_host,
  port: 5432,
  user: p.db_user,
  database: p.db_name,
  password: cfg.db_password,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.join(path.dirname(privatePath), 'supabase-ca.crt')),
  },
});
const origin = 'https://magnet-os-staging.vercel.app';
async function request(route, body, token, method = 'POST') {
  const r = await fetch(base + route, {
    method,
    headers: {
      apikey: anon,
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const check = (value, label) => {
  assert.ok(value, label);
  console.log('PASS', label);
};
await db.connect();
try {
  const migrations = (
    await db.query('select count(*)::int n from supabase_migrations.schema_migrations')
  ).rows[0].n;
  assert.equal(migrations, 47, 'All hosted staging migrations must be applied first');
  const org = (await db.query("select id from organizations where slug='magnet'")).rows[0].id;
  const other = (
    await db.query(
      "insert into organizations(name,slug) values ('Release Isolation QA','release-isolation-qa') on conflict (lower(btrim(slug))) do update set name=excluded.name returning id",
    )
  ).rows[0].id;
  for (const key of ['owner', 'sales', 'content_creator'])
    await db.query(
      'insert into organization_roles(organization_id,key,name) values($1,$2,$2) on conflict do nothing',
      [org, key],
    );
  await db.query(
    "insert into role_capabilities(role_id,capability_id) select r.id,c.id from organization_roles r cross join capabilities c where r.organization_id=$1 and r.key='owner' on conflict do nothing",
    [org],
  );
  cfg.qa ??= {
    accountId: 'release-qa-' + crypto.randomBytes(8).toString('hex'),
    username: 'release.qa.' + crypto.randomBytes(8).toString('hex'),
    password: 'Qa1!' + crypto.randomBytes(24).toString('base64url'),
  };
  const q = cfg.qa;
  q.email = q.username + '@example.invalid';
  fs.writeFileSync(privatePath, JSON.stringify(cfg), { mode: 0o600 });
  const salt = crypto.randomBytes(16),
    hash =
      'pbkdf2$150000$' +
      salt.toString('base64') +
      '$' +
      crypto.pbkdf2Sync(q.password, salt, 150000, 32, 'sha256').toString('base64');
  await db.query(
    "insert into records(id,coll,organization_id,data) values($1,'_accounts',$2,$3) on conflict(id) do nothing",
    [
      'acct-' + q.accountId,
      org,
      JSON.stringify({
        id: q.accountId,
        fullName: 'Release QA Owner',
        username: q.username,
        email: q.email,
        role: 'Owner',
        status: 'Active',
        verified: true,
        passwordHash: hash,
      }),
    ],
  );
  const login = await request('/functions/v1/accounts', {
    action: 'login',
    identifier: q.username,
    password: q.password,
  });
  check(login.status === 200 && login.body.ok, 'real accounts login');
  const upgrade = await request('/functions/v1/accounts', {
    action: 'authv2',
    identifier: q.username,
    password: q.password,
  });
  check(upgrade.status === 200 && upgrade.body.session?.access_token, 'real Supabase Auth session');
  let token = upgrade.body.session.access_token;
  q.session = upgrade.body.session;
  const context = await request('/functions/v1/identity', { action: 'context' }, token);
  check(
    context.status === 200 &&
      context.body.context?.memberships.some(
        (m) => m.organizationId === org && m.roleKey === 'owner',
      ),
    'canonical owner/workspace resolution',
  );
  q.userId = context.body.context.userId;
  q.organizationId = org;
  fs.writeFileSync(privatePath, JSON.stringify(cfg), { mode: 0o600 });
  const denied = await request('/functions/v1/identity', { action: 'context' });
  check(denied.status === 401, 'missing JWT rejected');
  await db.query(
    "insert into records(id,coll,organization_id,data) values('release-isolation-project','projects',$1,'{\"name\":\"Isolation QA\"}') on conflict do nothing",
    [other],
  );
  const isolated = await request(
    '/rest/v1/records?organization_id=eq.' + other,
    undefined,
    token,
    'GET',
  );
  check(
    isolated.status === 200 && Array.isArray(isolated.body) && isolated.body.length === 0,
    'cross-tenant records hidden by RLS',
  );
  const deniedWrite = await request(
    '/rest/v1/records',
    {
      id: 'release-forbidden-' + crypto.randomUUID(),
      coll: 'projects',
      organization_id: other,
      data: { name: 'Denied' },
    },
    token,
  );
  check(deniedWrite.status === 403, 'cross-tenant write rejected by RLS');
  await db.query(
    'insert into records(id,coll,organization_id,data) values(\'release-client\',\'clients\',$1,\'{"name":"Release QA Client","status":"Active"}\'),(\'release-project\',\'projects\',$1,\'{"name":"Release QA Project","clientId":"release-client"}\'),(\'release-employee\',\'employees\',$1,\'{"fullName":"Release QA Employee"}\') on conflict do nothing',
    [org],
  );
  await db.query("update profiles set employee_id='release-employee' where id=$1", [q.userId]);
  const clientId = (
    await db.query("select id from client_accounts where legacy_record_id='release-client'")
  ).rows[0].id;
  q.taskCommand ??= crypto.randomUUID();
  fs.writeFileSync(privatePath, JSON.stringify(cfg), { mode: 0o600 });
  const payload = {
    p_organization_id: org,
    p_command_id: q.taskCommand,
    p_payload: {
      p_title: 'Hosted release retry QA',
      p_client_account_id: clientId,
      p_project_record_id: 'release-project',
      p_assigned_employee_record_id: 'release-employee',
      p_priority: 'Normal',
      p_start_date: '2026-09-26',
      p_due_date: '2026-10-01',
      p_estimated_hours: 2,
      p_brief: 'Hosted persistence QA',
      p_client_visible: false,
    },
  };
  const one = await request('/rest/v1/rpc/create_task_command_v2', payload, token),
    two = await request('/rest/v1/rpc/create_task_command_v2', payload, token);
  check(
    one.status === 200 &&
      two.status === 200 &&
      one.body.task?.id === two.body.task?.id &&
      two.body.replayed,
    'task creation retry returns one persisted task',
  );
  const refresh = await request('/auth/v1/token?grant_type=refresh_token', {
    refresh_token: q.session.refresh_token,
  });
  check(refresh.status === 200 && refresh.body.access_token, 'refresh token session restoration');
  q.session = refresh.body;
  fs.writeFileSync(privatePath, JSON.stringify(cfg), { mode: 0o600 });
  const restored = await request(
    '/functions/v1/identity',
    { action: 'context' },
    refresh.body.access_token,
  );
  check(restored.status === 200, 'restored session resolves identity');
  console.log(
    'Hosted smoke passed. Synthetic QA records retained for browser verification; no production changes.',
  );
} finally {
  await db.end();
}
