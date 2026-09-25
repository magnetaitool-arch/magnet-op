import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyTaskDependencies({ client, orgA, orgB, user, asRole, connect }) {
  const clientId = (
    await client.query("select id from client_accounts where legacy_record_id='test-client-a'")
  ).rows[0].id;
  const create = async (title, connection = client) =>
    (
      await connection.query(
        "select create_task_v2($1,$2,$3,'workflow-project','workflow-employee') result",
        [orgA, title, clientId],
      )
    ).rows[0].result.task;
  const change = async (id, to) => {
    const task = (await client.query('select get_task_v2($1,$2) result', [orgA, id])).rows[0].result
      .task;
    return (
      await client.query('select change_task_status_v2($1,$2,$3,$4,null) result', [
        orgA,
        id,
        task.version,
        to,
      ])
    ).rows[0].result;
  };
  const set = async (id, prereq, action = 'ADD', key = randomUUID(), org = orgA) =>
    (
      await client.query('select set_task_dependency_v2($1,$2,$3,$4,$5) result', [
        org,
        id,
        prereq,
        action,
        key,
      ])
    ).rows[0].result;
  const reject = async (fn, pattern) => {
    await client.query('savepoint dependency');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint dependency');
  };
  await asRole('authenticated', async () => {
    const a = await create('Design approved concept'),
      b = await create('Execute design'),
      c = await create('Export deliverable'),
      key = randomUUID();
    const first = await set(b.id, a.id, 'ADD', key);
    assert.equal(first.blockedCount, 1);
    assert.equal(first.items[0].title, a.title);
    assert.equal((await set(b.id, a.id, 'ADD', key)).replayed, true);
    await reject(() => set(b.id, c.id, 'ADD', key), /idempotency_conflict/);
    await set(c.id, b.id);
    await reject(() => set(a.id, c.id), /task_dependency_cycle/);
    await reject(() => set(a.id, a.id), /request_invalid/);
    await reject(() => change(b.id, 'In Progress'), /task_dependencies_incomplete/);
    await change(a.id, 'In Progress');
    await change(a.id, 'Done');
    await change(b.id, 'In Progress');
    await reject(() => change(a.id, 'In Progress'), /pause_dependent_tasks_before_reopening/);
    await reject(() => set(b.id, c.id), /pause_task_before_dependency_change/);
    await reject(
      () =>
        client.query(
          "update records set data=jsonb_set(data,'{projectId}','\"unlinked\"') where id=$1",
          [a.legacyRecordId],
        ),
      /task_dependency_relationship_locked/,
    );
    await change(b.id, 'Done');
    await change(c.id, 'In Progress');
    const removeKey = randomUUID();
    assert.equal((await set(c.id, b.id, 'REMOVE', removeKey)).items.length, 0);
    assert.equal((await set(c.id, b.id, 'REMOVE', removeKey)).replayed, true);
    await reject(() => set(a.id, b.id, 'REMOVE', randomUUID(), orgB), { code: '42501' });
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          'select count(*)::int n from task_dependencies_v2 where task_id=$1 and removed_at is not null',
          [c.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from task_events_v2 where task_id=$1 and safe_context->>'kind'='DEPENDENCY_ADD'",
          [b.id],
        )
      ).rows[0].n,
      1,
    );
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      user,
    ]);
    await client.query('set local role authenticated');
    await reject(() => set(b.id, a.id, 'ADD', key), { code: '42501' });
  });
  await asRole('authenticated', async () => {
    const parent = await create('Assigned visible task'),
      prerequisite = await create('Private creative research');
    await set(parent.id, prerequisite.id);
    await client.query('set local role postgres');
    await client.query(
      "insert into records(id,coll,organization_id,data) values('private-dependency-owner','employees',$1,'{\"fullName\":\"Synthetic second owner\"}')",
      [orgA],
    );
    const other = '00000000-0000-4000-8000-000000000002';
    await client.query(
      "update profiles set employee_id='private-dependency-owner',identity_status='ACTIVE' where id=$1",
      [other],
    );
    await client.query(
      "insert into organization_members(organization_id,user_id,role_id,status,joined_at) select organization_id,$1,role_id,'ACTIVE',now() from organization_members where user_id=$2 and organization_id=$3 on conflict(organization_id,user_id) do update set status='ACTIVE',joined_at=now()",
      [other, user, orgA],
    );
    await client.query(
      "update records set data=jsonb_set(data,'{assignedTo}','\"private-dependency-owner\"') where id=$1",
      [prerequisite.legacyRecordId],
    );
    await client.query(
      "delete from role_capabilities where capability_id=(select id from capabilities where key='work.manage') and role_id=(select role_id from organization_members where user_id=$1 and organization_id=$2)",
      [user, orgA],
    );
    await client.query('set local role authenticated');
    const out = (
      await client.query('select get_task_dependencies_v2($1,$2,null) result', [orgA, parent.id])
    ).rows[0].result;
    assert.equal(out.items[0].title, null);
    assert.equal(out.blockedCount, 1);
    assert.equal(out.candidates.length, 0);
    assert.equal(out.canManage, false);
    await reject(() => set(parent.id, prerequisite.id, 'REMOVE'), { code: '42501' });
  });
  await assert.rejects(
    asRole('authenticated', () => client.query('select * from task_dependencies_v2')),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () =>
      client.query('select get_task_dependencies_v2($1,$2,null)', [orgA, randomUUID()]),
    ),
    { code: '42501' },
  );
  // Concurrent opposite edges must serialize and reject one cycle, not commit both.
  const setup = connect();
  let a, b;
  try {
    await setup.connect();
    await setup.query('begin');
    await setup.query('set local role authenticated');
    await setup.query(
      "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
      [user],
    );
    a = await create('Concurrent prerequisite A', setup);
    b = await create('Concurrent prerequisite B', setup);
    await setup.query('commit');
  } finally {
    await setup.end();
  }
  const connections = [connect(), connect()];
  try {
    const results = await Promise.all(
      connections.map(async (c, i) => {
        await c.connect();
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(
          "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
          [user],
        );
        try {
          await c.query('select set_task_dependency_v2($1,$2,$3,$4,$5)', [
            orgA,
            i ? a.id : b.id,
            i ? b.id : a.id,
            'ADD',
            randomUUID(),
          ]);
          await c.query('commit');
          return 'saved';
        } catch (e) {
          await c.query('rollback');
          return e.message;
        }
      }),
    );
    assert.equal(results.filter((x) => x === 'saved').length, 1);
    assert.equal(results.filter((x) => x === 'task_dependency_cycle').length, 1);
  } finally {
    await Promise.all(connections.map((c) => c.end()));
  }
  console.log(
    'PASS task dependencies: prerequisite execution gates, cycles including concurrent opposite edges, immutable audit/tombstone/retry, tenant/anon/revocation, linked-project drift and safe reopening',
  );
}
