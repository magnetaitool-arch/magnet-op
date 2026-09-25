import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyTaskCreate({ client, orgA, orgB, user, asRole, connect }) {
  const clientId = (
    await client.query("select id from client_accounts where legacy_record_id='test-client-a'")
  ).rows[0].id;
  const payload = {
    p_title: 'Retry safe assigned work',
    p_client_account_id: clientId,
    p_project_record_id: 'workflow-project',
    p_assigned_employee_record_id: 'workflow-employee',
    p_priority: 'Normal',
    p_start_date: '2026-09-26',
    p_due_date: '2026-10-01',
    p_estimated_hours: 2,
    p_brief: 'Use saved execution brief',
    p_client_visible: false,
  };
  const create = async (data = payload, key = randomUUID(), org = orgA) =>
    (
      await client.query('select create_task_command_v2($1,$2,$3) result', [
        org,
        JSON.stringify(data),
        key,
      ])
    ).rows[0].result;
  const reject = async (fn, pattern) => {
    await client.query('savepoint create_task');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint create_task');
  };
  await asRole('authenticated', async () => {
    const key = randomUUID(),
      one = await create(payload, key),
      two = await create(payload, key);
    assert.equal(one.task.id, two.task.id);
    assert.equal(two.replayed, true);
    assert.equal(one.task.assignedUserId, user);
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from task_events_v2 where task_id=$1 and action='CREATED'",
          [one.task.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          'select count(*)::int n from user_notifications_v2 where source_key=$1',
          ['task-assigned:' + one.task.id + ':1'],
        )
      ).rows[0].n,
      1,
    );
    await reject(() => create({ ...payload, p_title: 'Changed' }, key), /idempotency_conflict/);
    const moved = (
      await client.query("select change_task_status_v2($1,$2,$3,'In Progress',null) result", [
        orgA,
        one.task.id,
        one.task.version,
      ])
    ).rows[0].result;
    assert.equal(moved.task.status, 'In Progress');
    assert.equal((await create(payload, key)).task.status, 'In Progress');
    await client.query('set local role postgres');
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      user,
    ]);
    await client.query('set local role authenticated');
    await reject(() => create(payload, key), { code: '42501' });
  });
  for (const patch of [
    { p_status: 'Done' },
    { organization_id: orgB },
    { p_assigned_employee_record_id: 'ambiguous-owner' },
    { p_client_visible: 'true' },
    { p_estimated_hours: -1 },
    { p_estimated_hours: 0.123 },
    { p_start_date: 'infinity' },
    { p_due_date: '2026-01-01' },
    { p_title: { unsafe: 'object' } },
  ])
    await assert.rejects(asRole('authenticated', () => create({ ...payload, ...patch })));
  await assert.rejects(
    asRole('authenticated', () => create(payload, randomUUID(), orgB)),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () => create()),
    { code: '42501' },
  );
  await asRole('authenticated', async () => {
    await client.query('set local role postgres');
    const before = (
      await client.query(
        'select (select count(*) from work_tasks) tasks,(select count(*) from user_notifications_v2) notifications,(select count(*) from task_events_v2) events',
      )
    ).rows[0];
    await client.query(
      "create function pg_temp.reject_task_command() returns trigger language plpgsql as $$begin raise exception 'synthetic ledger failure';end;$$;create trigger qa_ledger_failure before insert on task_create_commands_v2 for each row execute function pg_temp.reject_task_command()",
    );
    await client.query('set local role authenticated');
    await reject(() => create(), /synthetic ledger failure/);
    await client.query('set local role postgres');
    assert.deepEqual(
      (
        await client.query(
          'select (select count(*) from work_tasks) tasks,(select count(*) from user_notifications_v2) notifications,(select count(*) from task_events_v2) events',
        )
      ).rows[0],
      before,
    );
  });
  await asRole('authenticated', async () => {
    await reject(
      () =>
        client.query(
          'insert into records(id,coll,organization_id,data) values(\'raw-owner-bypass\',\'tasks\',$1,\'{"title":"Invalid owner","clientId":"test-client-a","projectId":"workflow-project","status":"Backlog","assignedTo":"missing"}\')',
          [orgA],
        ),
      /task_assignee_review_required/,
    );
    await client.query('set local role postgres');
    await client.query(
      "update profiles set employee_id='workflow-employee' where id='00000000-0000-4000-8000-000000000002'",
    );
    await client.query('set local role authenticated');
    await reject(() => create(), /task_assignee_review_required/);
  });
  const connections = [connect(), connect()],
    key = randomUUID();
  try {
    const results = await Promise.all(
      connections.map(async (c) => {
        await c.connect();
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(
          "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
          [user],
        );
        const out = (
          await c.query('select create_task_command_v2($1,$2,$3) result', [
            orgA,
            JSON.stringify(payload),
            key,
          ])
        ).rows[0].result;
        await c.query('commit');
        return out;
      }),
    );
    assert.equal(results[0].task.id, results[1].task.id);
    assert.equal(results.filter((x) => x.replayed).length, 1);
  } finally {
    await Promise.all(connections.map((c) => c.end()));
  }
  console.log(
    'PASS retry-safe task creation: one task/event/notification across concurrent retries, current replay, strict input and active owner, revoked/tenant/anon denial, complete rollback on late failure',
  );
}
