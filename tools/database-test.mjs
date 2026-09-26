import { verifyEmployeeRequests } from './employee-requests-database-test.mjs';
import { verifyTaskDependencies } from './task-dependencies-database-test.mjs';
import { verifyTaskCreate } from './task-create-database-test.mjs';
import { verifyTaskStatusAuthority } from './task-status-database-test.mjs';
import { verifyTaskProjectRelationships } from './task-project-database-test.mjs';
import { verifyProjectBriefs } from './project-brief-database-test.mjs';
import { verifyPublicProposal } from './proposal-public-database-test.mjs';
import { verifyProposalRevisions } from './proposals-database-test.mjs';
import { verifyFollowups } from './followups-database-test.mjs';
import { verifyConversion, verifyConcurrentConversion } from './conversion-database-test.mjs';
import { verifyWorkflowSegments } from './workflow-database-test.mjs';
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { verifyProjectSetup } from './project-setup-database-test.mjs';
import { verifyOnboarding } from './onboarding-database-test.mjs';
import { verifyWorkflowAuthority } from './workflow-authority-database-test.mjs';
import { verifyProposalHandoff } from './proposal-handoff-database-test.mjs';
import { verifyApprovalIdentity } from './approval-identity-database-test.mjs';
import { createServer } from 'node:net';

// Always starts its own loopback-only cluster. No DATABASE_URL, secrets or live data.
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => resolve());
});
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
const directory = await mkdtemp(join(tmpdir(), 'magnet-db-test-'));
const database = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'),
  port,
  user: 'postgres',
  password: randomBytes(32).toString('hex'),
  authMethod: 'scram-sha-256',
  persistent: true,
  createPostgresUser: false,
  postgresFlags: ['-h', '127.0.0.1', '-k', directory],
  onLog: () => {},
  onError: () => {},
});
let client;
let current = 'platform fixture';
let failed = false;
try {
  await database.initialise();
  await database.start();
  client = database.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  await client.query(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as
      $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant usage on schema auth,storage,public to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner uuid,metadata jsonb);
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  current = 'legacy schema fixture';
  await client.query(
    await readFile(new URL('./fixtures/legacy-schema.sql', import.meta.url), 'utf8'),
  );
  const migrations = (await readdir('supabase/migrations'))
    .filter((name) => name.endsWith('.sql') && name >= '20260816101341')
    .sort();
  for (const name of migrations) {
    current = name;
    if (name.startsWith('20260825170000'))
      await client.query(
        "insert into public.organizations(name,slug) values ('Synthetic migration fixture','magnet')",
      );
    let relationshipFixtureBefore;
    if (name.includes('task_project_relationships')) {
      const migrationOrg = (await client.query("select id from organizations where slug='magnet'"))
        .rows[0].id;
      await client.query(
        `insert into records(id,coll,organization_id,data) values
        ('migration-client','clients',$1,'{"name":"Synthetic migration client"}'),
        ('migration-project','projects',$1,'{"name":"Synthetic migration project","clientId":"migration-client"}'),
        ('migration-task-valid','tasks',$1,'{"title":"Preserved valid task","clientId":"migration-client","projectId":"migration-project"}'),
        ('migration-task-unresolved','tasks',$1,'{"title":"Preserved unresolved task","clientId":"migration-client","projectId":"missing-project"}')`,
        [migrationOrg],
      );
      relationshipFixtureBefore = (
        await client.query(
          "select id,to_jsonb(r) row from records r where id like 'migration-%' order by id",
        )
      ).rows;
    }
    await client.query(await readFile(join('supabase/migrations', name), 'utf8'));
    if (relationshipFixtureBefore) {
      assert.deepEqual(
        (
          await client.query(
            "select id,to_jsonb(r) row from records r where id like 'migration-%' order by id",
          )
        ).rows,
        relationshipFixtureBefore,
      );
      assert.deepEqual(
        (
          await client.query(
            "select legacy_record_id,project_reference_id from work_tasks where legacy_record_id like 'migration-%' order by legacy_record_id",
          )
        ).rows,
        [
          { legacy_record_id: 'migration-task-unresolved', project_reference_id: null },
          { legacy_record_id: 'migration-task-valid', project_reference_id: 'migration-project' },
        ],
      );
      assert.equal(
        (
          await client.query(
            "select count(*)::int n from task_projection_issues_v2 where legacy_record_id='migration-task-unresolved' and issue_code='PROJECT_RELATIONSHIP_REVIEW_REQUIRED' and resolved_at is null",
          )
        ).rows[0].n,
        1,
      );
      // Remove only the explicitly named, synthetic migration fixture after reconciliation.
      await client.query(
        "delete from work_tasks where legacy_record_id in('migration-task-valid','migration-task-unresolved'); delete from task_projection_issues_v2 where legacy_record_id in('migration-task-valid','migration-task-unresolved'); delete from records where id in('migration-task-valid','migration-task-unresolved','migration-project'); delete from client_accounts where legacy_record_id='migration-client'; delete from records where id='migration-client'",
      );
      console.log(
        'PASS task relationship migration rehearsal: all source rows/values unchanged, valid FK populated, unresolved row retained and flagged',
      );
    }
    console.log(`PASS migration ${name}`);
  }
  current = 'authorization behavior';
  const orgA = (await client.query("select id from organizations where slug='magnet'")).rows[0].id;
  const orgB = (
    await client.query(
      "insert into organizations(name,slug) values ('Synthetic second tenant','test-b') returning id",
    )
  ).rows[0].id;
  const user = '00000000-0000-4000-8000-000000000001';
  await client.query(
    `insert into auth.users(id,email,raw_user_meta_data) values ($1,'local-test@example.invalid','{"role":"Owner"}')`,
    [user],
  );
  const profile = (
    await client.query('select role,identity_status from profiles where id=$1', [user])
  ).rows[0];
  assert.equal(profile.role, 'Viewer');
  // Distinct emails sharing a local part must not collide on legacy username.
  await client.query(
    "insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000002','local-test@second.invalid')",
  );
  assert.equal(profile.identity_status, 'PENDING_SETUP');
  assert.equal(
    (await client.query("select username from profiles where email='local-test@second.invalid'"))
      .rows[0].username,
    null,
  );
  // Replaying provisioning may reconcile the email, but never reset an existing alias/name.
  await client.query(
    "update profiles set username='retained-alias',display_name='Retained name' where id=$1",
    [user],
  );
  await client.query(
    'create trigger test_provisioning_replay after update on auth.users for each row execute function public.handle_new_user()',
  );
  await client.query(
    'update auth.users set raw_user_meta_data=\'{"role":"Owner","display_name":"Changed"}\' where id=$1',
    [user],
  );
  assert.deepEqual(
    (await client.query('select username,display_name,role from profiles where id=$1', [user]))
      .rows[0],
    { username: 'retained-alias', display_name: 'Retained name', role: 'Viewer' },
  );
  const concurrent = [
    database.getPgClient('postgres', '127.0.0.1'),
    database.getPgClient('postgres', '127.0.0.1'),
  ];
  try {
    await Promise.all(concurrent.map((connection) => connection.connect()));
    const results = await Promise.allSettled(
      concurrent.map((connection, index) =>
        connection.query('insert into auth.users(id,email) values ($1,$2)', [
          `00000000-0000-4000-8000-00000000000${index + 4}`,
          `concurrent@tenant${index}.invalid`,
        ]),
      ),
    );
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    const names = (
      await client.query("select username from profiles where email like 'concurrent@%'")
    ).rows.map((row) => row.username);
    assert.equal(names.length, 2);
    assert.ok(names.includes(null));
    assert.ok(names.includes('concurrent'));
  } finally {
    await Promise.all(concurrent.map((connection) => connection.end()));
  }

  await client.query(
    "insert into auth.users(id,email,raw_user_meta_data) values ('00000000-0000-4000-8000-000000000003','long-name@example.invalid',jsonb_build_object('display_name',repeat('A',300)))",
  );
  assert.equal(
    (
      await client.query(
        "select length(display_name) as n from profiles where email='long-name@example.invalid'",
      )
    ).rows[0].n,
    160,
  );
  assert.equal(
    (
      await client.query('select count(*)::int as n from organization_members where user_id=$1', [
        user,
      ])
    ).rows[0].n,
    0,
  );
  await client.query("update profiles set identity_status='ACTIVE' where id=$1", [user]);
  const role = (
    await client.query(
      "insert into organization_roles(organization_id,key,name) values ($1,'test_reader','Test reader') returning id",
      [orgA],
    )
  ).rows[0].id;
  await client.query(
    "insert into capabilities(key,description) values ('clients.read','Read clients') on conflict(key) do nothing",
  );
  await client.query(
    "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='clients.read'",
    [role],
  );
  await client.query(
    'insert into organization_members(organization_id,user_id,role_id,joined_at) values ($1,$2,$3,now())',
    [orgA, user, role],
  );
  for (const [org, id] of [
    [orgA, 'test-client-a'],
    [orgB, 'test-client-b'],
  ]) {
    await client.query(
      "insert into records(id,coll,organization_id,data) values ($1,'clients',$2,$3)",
      [id, org, JSON.stringify({ name: id, status: 'Active' })],
    );
  }
  assert.equal((await client.query('select count(*)::int as n from client_accounts')).rows[0].n, 2);
  async function asRole(roleName, action) {
    await client.query('begin');
    try {
      await client.query(`set local role ${roleName}`);
      await client.query(
        "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",
        [user, roleName],
      );
      return await action();
    } finally {
      await client.query('rollback');
    }
  }
  await assert.rejects(
    asRole('anon', () => client.query('select * from client_accounts')),
    { code: '42501' },
  );
  await asRole('authenticated', async () => {
    const visible = await client.query('select organization_id from client_accounts');
    assert.equal(visible.rowCount, 1);
    assert.equal(visible.rows[0].organization_id, orgA);
    assert.equal(
      (
        await client.query('select public.has_org_capability($1, $2) as allowed', [
          orgB,
          'clients.read',
        ])
      ).rows[0].allowed,
      false,
    );
  });
  await assert.rejects(
    asRole('authenticated', () =>
      client.query("update client_accounts set display_name='Unauthorized'"),
    ),
    { code: '42501' },
  );
  await asRole('service_role', async () =>
    assert.equal((await client.query('select * from client_accounts')).rowCount, 2),
  );
  await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [user]);
  await asRole('authenticated', async () =>
    assert.equal((await client.query('select * from client_accounts')).rowCount, 0),
  );
  await client.query("update organization_members set status='ACTIVE' where user_id=$1", [user]);
  await client.query('delete from role_capabilities where role_id=$1', [role]);
  await asRole('authenticated', async () =>
    assert.equal((await client.query('select * from client_accounts')).rowCount, 0),
  );
  // Storage SQL policies are exercised against metadata fixtures, not a fake Storage HTTP server.
  await client.query(
    "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key in ('documents.manage','documents.read')",
    [role],
  );
  const createUpload = async (organization = orgA) =>
    (
      await client.query(
        "select public.create_document_upload_v2($1,'Synthetic document','Company Document','INTERNAL','test.txt','text/plain',12) as result",
        [organization],
      )
    ).rows[0].result;
  assert.equal(
    (await client.query("select public from storage.buckets where id='magnet-documents'")).rows[0]
      .public,
    false,
  );
  await assert.rejects(
    asRole('authenticated', () => createUpload(orgB)),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () =>
      client.query(
        "insert into storage.objects(bucket_id,name) values ('magnet-documents','forged/path.txt')",
      ),
    ),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      const slot = await createUpload();
      await client.query('select public.finalize_document_upload_v2($1,$2)', [orgA, slot.id]);
    }),
    { message: 'original_upload_missing' },
  );
  await asRole('authenticated', async () => {
    const slot = await createUpload();
    await client.query(
      "insert into storage.objects(bucket_id,name) values ('magnet-documents',$1)",
      [slot.originalPath],
    );
    const completed = (
      await client.query('select public.finalize_document_upload_v2($1,$2) as result', [
        orgA,
        slot.id,
      ])
    ).rows[0].result;
    assert.equal(completed.status, 'ACTIVE');
    assert.equal(completed.version, 2);
  });
  for (const command of ['finalize_document_upload_v2', 'cancel_document_upload_v2']) {
    await assert.rejects(
      asRole('authenticated', async () => {
        const slot = await createUpload();
        await client.query('set local role postgres');
        await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
          user,
        ]);
        await client.query('set local role authenticated');
        await client.query(`select public.${command}($1,$2)`, [orgA, slot.id]);
      }),
      { code: '42501' },
    );
    await assert.rejects(
      asRole('authenticated', async () => {
        const slot = await createUpload();
        await client.query('set local role postgres');
        await client.query('delete from role_capabilities where role_id=$1', [role]);
        await client.query('set local role authenticated');
        await client.query(`select public.${command}($1,$2)`, [orgA, slot.id]);
      }),
      { code: '42501' },
    );
  }
  console.log(
    'PASS private storage policy, upload-slot enforcement, missing-object rejection, finalize, suspended uploader and revoked permission',
  );
  console.log(
    'PASS untrusted role metadata, pending identity, anon denial, tenant isolation, write denial, service context, suspension and capability revocation',
  );
  await verifyEmployeeRequests(client);
  await verifyWorkflowSegments({ client, orgA, orgB, user, role, asRole });
  await verifyTaskProjectRelationships({ client, orgA, orgB, user, asRole });
  await verifyTaskStatusAuthority({ client, orgA, orgB, user, role, asRole });
  await verifyApprovalIdentity({ client, orgA, user, role, asRole });
  await verifyProposalHandoff({ client, orgA, orgB, user, role, asRole });
  await verifyWorkflowAuthority({ client, orgA, orgB, user, asRole });
  await verifyOnboarding({ client, orgA, orgB, user, asRole });
  await verifyProjectSetup({
    client,
    orgA,
    orgB,
    user,
    role,
    asRole,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  await verifyProjectBriefs({
    client,
    orgA,
    orgB,
    user,
    asRole,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  await verifyTaskCreate({
    client,
    orgA,
    orgB,
    user,
    asRole,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  await verifyTaskDependencies({
    client,
    orgA,
    orgB,
    user,
    asRole,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  await verifyFollowups({
    client,
    orgA,
    orgB,
    user,
    role,
    asRole,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  await verifyProposalRevisions({
    client,
    orgA,
    orgB,
    user,
    role,
    asRole,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  await verifyPublicProposal({ client, orgA, orgB, user, role, asRole });
  await verifyConversion({ client, orgA, orgB, user, role, asRole });
  await verifyConcurrentConversion({
    client,
    orgA,
    user,
    connect: () => database.getPgClient('postgres', '127.0.0.1'),
  });
  const persistedClientCount = (await client.query('select count(*)::int n from client_accounts'))
    .rows[0].n;
  await client.end();
  client = undefined;
  await database.stop();
  await database.start();
  client = database.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  assert.equal(
    (await client.query('select count(*)::int as n from client_accounts')).rows[0].n,
    persistedClientCount,
  );
  assert.equal((await client.query('select count(*)::int n from crm_followups_v2')).rows[0].n, 1);
  assert.equal(
    (await client.query('select count(*)::int n from proposal_revisions_v2')).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int n from project_setup_commands_v2 c join records r on r.organization_id=c.organization_id and r.id=c.result->'project'->>'id' and r.coll='projects'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await client.query('select count(*)::int n from project_brief_revisions_v2')).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        'select count(*)::int n from task_create_commands_v2 c join work_tasks t on t.id=c.task_id and t.organization_id=c.organization_id',
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await client.query(
        'select count(*)::int n from task_dependencies_v2 where removed_at is null',
      )
    ).rows[0].n,
    1,
  );
  console.log(
    'PASS database survives process restart, including committed projects, brief snapshots, follow-ups and proposal revisions',
  );
  current = 'function rollback and reapply';
  async function captureBusinessRows() {
    const names = (
      await client.query(
        "select tablename from pg_tables where schemaname='public' order by tablename",
      )
    ).rows.map((row) => row.tablename);
    const rows = {};
    for (const name of names) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      rows[name] = (await client.query(`select to_jsonb(t) as data from public.${quoted} t`)).rows
        .map((row) => JSON.stringify(row.data))
        .sort();
    }
    return rows;
  }
  const beforeRepairReplay = await captureBusinessRows();
  const functionDefinitions = async () =>
    (
      await client.query(
        "select p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by p.proname,args",
      )
    ).rows;
  const functionsBeforeRepair = await functionDefinitions();
  const functionSources = [
    [
      '20260826023000_tasks_search_notifications_v2.sql',
      ['task_user_for_employee_v2', 'task_is_current_assignee_v2'],
    ],
    ['20260825115306_secure_auth_profile_trigger.sql', ['handle_new_user']],
    [
      '20260826010000_document_storage_v2.sql',
      ['finalize_document_upload_v2', 'cancel_document_upload_v2'],
    ],
  ];
  for (const [source, names] of functionSources) {
    const sql = await readFile(join('supabase/migrations', source), 'utf8');
    for (const name of names) {
      const start = sql.indexOf(`create or replace function public.${name}(`);
      assert.ok(start >= 0);
      const end = sql.indexOf('$$;', sql.indexOf('as $$', start) + 5) + 3;
      assert.ok(end > start);
      await client.query(sql.slice(start, end));
    }
  }
  await client.query('drop function public.convert_crm_lead_v2(uuid,text,integer)');
  for (const name of migrations.filter(
    (name) =>
      name.includes('safe_profile_provisioning') ||
      name.includes('recheck_upload_authorization') ||
      name.includes('recheck_task_status_authorization') ||
      name.includes('unambiguous_task_identity') ||
      name.includes('atomic_lead_conversion'),
  )) {
    await client.query(await readFile(join('supabase/migrations', name), 'utf8'));
  }
  // Reapply the latest definition after rehearsing the older status-auth repair.
  const statusAuthority = await readFile(
    'supabase/migrations/20260925221432_task_status_authority.sql',
    'utf8',
  );
  const statusStart = statusAuthority.indexOf(
    'create or replace function public.change_task_status_v2(',
  );
  const statusEnd =
    statusAuthority.indexOf('$$;', statusAuthority.indexOf('as $$', statusStart) + 5) + 3;
  await client.query(statusAuthority.slice(statusStart, statusEnd));
  assert.deepEqual(await functionDefinitions(), functionsBeforeRepair);
  assert.equal(
    (await client.query('select count(*)::int as n from client_accounts')).rows[0].n,
    persistedClientCount,
  );
  assert.equal((await client.query('select count(*)::int as n from profiles')).rows[0].n, 5);
  assert.deepEqual(await captureBusinessRows(), beforeRepairReplay);
  console.log(
    'PASS before/after reconciliation: all representative public row values and relationships unchanged',
  );
  console.log('PASS function rollback/reapply retains client and identity rows');
  if (process.env.MAGNET_FOLLOWUPS_BROWSER_QA === '1') {
    await client.query(
      "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='approvals.manage' on conflict do nothing",
      [role],
    );
    // Explicit synthetic relationship for the proposal -> existing client UI rehearsal.
    await client.query(
      'update records set data=data||\'{"leadId":"workflow-lead","mainContactEmail":"client@example.invalid","serviceType":"Branding"}\' where id=\'test-client-a\'',
    );
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query(
      "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
      [user],
    );
    const qaTask = (
      await client.query(
        "select create_task_v2($1,'Execute saved project brief',(select id from client_accounts where legacy_record_id='test-client-a'),'workflow-project','workflow-employee','Backlog','Normal',null,current_date,current_date+7,0,'Use the saved execution brief',null,null,false) result",
        [orgA],
      )
    ).rows[0].result;
    await client.query('commit');
    console.log(`Synthetic task QA id=${qaTask.task.id}`);
    const { serveFollowupsQA } = await import('./followups-browser-server.mjs');
    await serveFollowupsQA({
      connect: () => database.getPgClient('postgres', '127.0.0.1'),
      organizationId: orgA,
      userId: user,
    });
  }
  assert.ok(migrations.length > 20);
  console.log(
    `PASS ${migrations.length} ordered migrations on PostgreSQL 17 with synthetic platform fixtures`,
  );
} catch (error) {
  console.error(
    `FAIL ${current}: ${error instanceof Error ? error.message : 'Database process exited unexpectedly'}`,
  );
  failed = true;
} finally {
  await client?.end();
  await database.stop();
  await rm(directory, { recursive: true, force: true });
}
if (failed) process.exit(1);
