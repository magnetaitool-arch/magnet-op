import assert from 'node:assert/strict';
export async function verifyTaskStatusAuthority({ client, orgA, orgB, user, role, asRole }) {
  const reject = async (fn, pattern) => {
    await client.query('savepoint task_authority');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint task_authority');
  };
  await asRole('authenticated', async () => {
    const clientId = (
      await client.query("select id from client_accounts where legacy_record_id='test-client-a'")
    ).rows[0].id;
    const create = async (title) =>
      (
        await client.query(
          "select create_task_v2($1,$2,$3,'workflow-project','workflow-employee') result",
          [orgA, title, clientId],
        )
      ).rows[0].result.task;
    const first = await create('Exact task one'),
      second = await create('Exact task two');
    // Duplicate historical task codes must never make detail return a different row.
    await client.query(
      "update records set data=jsonb_set(data,'{taskCode}','\"DUPLICATE-CODE\"') where id=any($1::text[])",
      [[first.legacyRecordId, second.legacyRecordId]],
    );
    for (const task of [first, second])
      assert.equal(
        (await client.query('select get_task_v2($1,$2) result', [orgA, task.id])).rows[0].result
          .task.id,
        task.id,
      );
    const move = async (expected, status, org = orgA) =>
      (
        await client.query('select change_task_record_status_v2($1,$2,$3,$4,null) result', [
          org,
          first.legacyRecordId,
          expected,
          status,
        ])
      ).rows[0].result;
    await reject(
      () =>
        client.query(
          'update records set data=data||\'{"status":"Done","completedBy":"forged"}\' where id=$1',
          [first.legacyRecordId],
        ),
      /task_status_command_required/,
    );
    await reject(
      () =>
        client.query(
          "select create_task_v2($1,'Premature completion',$2,'workflow-project','workflow-employee','Done')",
          [orgA, clientId],
        ),
      /task_initial_status_invalid/,
    );
    await reject(() => move('Backlog', 'Done'), /invalid_task_transition/);
    await reject(() => move('Backlog', null), /invalid_task_status/);
    await reject(() => move('Backlog', 'In Progress', orgB), { code: '42501' });
    const started = await move('Backlog', 'In Progress');
    assert.equal(started.record.status, 'In Progress');
    assert.equal(
      (await client.query("select current_setting('app.task_status_command',true) value")).rows[0]
        .value,
      '',
    );
    await reject(() => move('Backlog', 'Done'), /task_status_conflict_reload/);
    const done = await move('In Progress', 'Done');
    assert.equal(done.record.completedBy, user);
    assert.ok(done.record.completedAt);
    assert.equal(
      (await client.query('select get_task_record_v2($1,$2) result', [orgA, first.legacyRecordId]))
        .rows[0].result.record.id,
      first.legacyRecordId,
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from task_events_v2 where task_id=$1 and action='STATUS_CHANGED'",
          [first.id],
        )
      ).rows[0].n,
      2,
    );
    await reject(
      () =>
        client.query(
          "update records set data=jsonb_set(data,'{completedAt}','\"2020-01-01\"') where id=$1",
          [first.legacyRecordId],
        ),
      /task_status_command_required/,
    );
    await client.query('set local role postgres');
    await client.query(
      "delete from role_capabilities where role_id=$1 and capability_id=(select id from capabilities where key='work.read')",
      [role],
    );
    await client.query('set local role authenticated');
    await reject(() => move('Done', 'In Progress'), { code: '42501' });
  });
  await assert.rejects(
    asRole('anon', () =>
      client.query("select change_task_record_status_v2($1,'none','Backlog','Done',null)", [orgA]),
    ),
    { code: '42501' },
  );
  console.log(
    'PASS task status authority: direct-write/completion forgery denial, valid legacy bridge, stale/invalid/revoked/tenant/anon denial, exact duplicate-code detail identity, server completion and one event per transition',
  );
}
