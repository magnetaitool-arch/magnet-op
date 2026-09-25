import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyFollowups({ client, orgA, orgB, user, role, asRole, connect }) {
  const id = randomUUID(),
    command = randomUUID();
  const params = [
    orgA,
    'workflow-lead',
    command,
    id,
    0,
    'Call prospect',
    '2026-10-01T10:00:00Z',
    'Africa/Cairo',
    user,
    'OPEN',
    null,
    null,
  ];
  const sql = 'select save_crm_followup_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) result';
  const save = async (changes = {}) =>
    (await client.query(sql, Object.assign([...params], changes))).rows[0].result;
  await asRole('authenticated', async () => {
    const first = await save();
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].status, 'OPEN');
    const repeat = await save();
    assert.equal(repeat.replayed, true);
    assert.equal(repeat.items[0].id, id);
    const next = await save({
      2: randomUUID(),
      4: 1,
      9: 'DONE',
      10: 'Discovery agreed',
      11: JSON.stringify({ title: 'Prepare proposal', dueAt: '2026-10-02T12:00:00Z' }),
    });
    assert.equal(next.items.length, 2);
    assert.equal(next.items.find((r) => r.id === id).status, 'DONE');
    assert.equal(next.items.find((r) => r.id === next.nextId).previous_id, id);
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='CRM_FOLLOWUP_SAVED'",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from user_notifications_v2 where notification_type='CRM_FOLLOWUP'",
        )
      ).rows[0].n,
      2,
    );
  });
  await assert.rejects(
    asRole('authenticated', async () => {
      await save();
      await save({ 5: 'Changed request reusing same key' });
    }),
    { code: '22023' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await save();
      await save({ 2: randomUUID(), 4: 0, 9: 'DONE', 10: 'Done' });
    }),
    { code: '40001' },
  );
  await assert.rejects(
    asRole('authenticated', () => save({ 0: orgB })),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () => save()),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () =>
      client.query('insert into crm_followups_v2(id) values(gen_random_uuid())'),
    ),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () => save({ 8: '00000000-0000-4000-8000-000000000002' })),
    { code: '42501' },
  );
  for (const revoke of [
    "update organization_members set status='SUSPENDED' where user_id=$1",
    "delete from role_capabilities where role_id=$1 and capability_id in(select id from capabilities where key='clients.manage')",
  ]) {
    await assert.rejects(
      asRole('authenticated', async () => {
        await save();
        await client.query('set local role postgres');
        await client.query(revoke, [revoke.startsWith('update') ? user : role]);
        await client.query('set local role authenticated');
        await save();
      }),
      { code: '42501' },
    );
  }
  await asRole('authenticated', async () => {
    await save();
    await client.query('savepoint before_completion');
    await assert.rejects(
      save({
        2: randomUUID(),
        4: 1,
        9: 'DONE',
        10: 'Done',
        11: JSON.stringify({ title: 'Missing date' }),
      }),
    );
    await client.query('rollback to savepoint before_completion');
    const row = (
      await client.query('select status,version from crm_followups_v2 where id=$1', [id])
    ).rows[0];
    assert.deepEqual(row, { status: 'OPEN', version: 1 });
    await client.query('savepoint missing_outcome');
    await assert.rejects(save({ 2: randomUUID(), 4: 1, 9: 'DONE' }));
    await client.query('rollback to savepoint missing_outcome');
  });
  await asRole('authenticated', async () => {
    await save({ 6: new Date(Date.now() - 86400000).toISOString() });
    const queue = (
      await client.query(
        "select list_crm_followup_queue_v2($1,'mine','overdue','Africa/Cairo',1) result",
        [orgA],
      )
    ).rows[0].result;
    assert.equal(queue.items.length, 1);
    assert.equal(queue.counts.overdue, 1);
    assert.equal(queue.items[0].legacy_record_id, 'workflow-lead');
    await client.query('savepoint worker_denied');
    await assert.rejects(client.query('select enqueue_due_crm_followups_v2(100)'), {
      code: '42501',
    });
    await client.query('rollback to savepoint worker_denied');
    await client.query('set local role service_role');
    assert.equal((await client.query('select enqueue_due_crm_followups_v2(100) n')).rows[0].n, 1);
    assert.equal((await client.query('select enqueue_due_crm_followups_v2(100) n')).rows[0].n, 0);
  });
  await assert.rejects(
    asRole('authenticated', () =>
      client.query("select list_crm_followup_queue_v2($1,'team','all')", [orgB]),
    ),
    { code: '42501' },
  );
  // Real simultaneous transactions commit one command and one notification.
  const connections = [connect(), connect()];
  try {
    await Promise.all(
      connections.map(async (c) => {
        await c.connect();
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(
          "select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",
          [user],
        );
      }),
    );
    const results = await Promise.all(
      connections.map(async (c) => {
        const result = (await c.query(sql, params)).rows[0].result;
        await c.query('commit');
        return result;
      }),
    );
    assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]);
    assert.equal((await client.query('select count(*)::int n from crm_followups_v2')).rows[0].n, 1);
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from user_notifications_v2 where notification_type='CRM_FOLLOWUP'",
        )
      ).rows[0].n,
      1,
    );
    await asRole('authenticated', async () => {
      await client.query('set local role postgres');
      await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
        user,
      ]);
      await client.query('set local role authenticated');
      assert.equal((await client.query('select * from crm_followups_v2')).rowCount, 0);
    });
  } finally {
    await Promise.all(
      connections.map(async (c) => {
        try {
          await c.query('rollback');
        } finally {
          await c.end();
        }
      }),
    );
  }
  console.log(
    'PASS durable follow-ups: owner/tenant/RLS/revocation, replay and concurrent dedupe, required outcome, atomic completion/next action and rollback',
  );
}
