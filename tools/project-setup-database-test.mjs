import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyProjectSetup({ client, orgA, orgB, user, role, asRole, connect }) {
  const payload = {
    projectName: 'Synthetic atomic project',
    projectType: 'Branding',
    clientId: 'test-client-a',
    projectManagerId: 'workflow-employee',
    startDate: '2026-09-01',
    deadline: '2026-10-01',
    status: 'Planning',
    projectBudget: 12000,
    currency: 'EGP',
    createInvoice: true,
    createDefaultTasks: true,
    templateAssigneeId: 'workflow-employee',
  };
  const run = async (data = payload, key = randomUUID(), org = orgA) =>
    (
      await client.query('select create_project_setup_v2($1,$2,$3) result', [
        org,
        JSON.stringify(data),
        key,
      ])
    ).rows[0].result;
  const finance = async () => {
    await client.query('set local role postgres');
    await client.query(
      "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='finance.manage' on conflict do nothing",
      [role],
    );
    await client.query('set local role authenticated');
  };
  await asRole('authenticated', async () => {
    await finance();
    const key = randomUUID(),
      out = await run(payload, key);
    assert.equal(out.ok, true);
    assert.equal(out.changes.filter((x) => x.coll === 'tasks').length, 10);
    assert.equal(out.changes.filter((x) => x.coll === 'invoices').length, 1);
    assert.equal((await run(payload, key)).project.id, out.project.id);
    assert.equal((await run(payload, key)).replayed, true);
    const tasks = (
      await client.query(
        'select assigned_user_id,due_date from work_tasks where project_record_id=$1',
        [out.project.id],
      )
    ).rows;
    assert.equal(tasks.length, 10);
    assert.equal(
      tasks.every((x) => x.assigned_user_id === user),
      true,
    );
    await client.query('savepoint changed');
    await assert.rejects(run({ ...payload, projectName: 'Changed' }, key), /idempotency_conflict/);
    await client.query('rollback to savepoint changed');
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='PROJECT_SETUP_CREATED' and entity_id=$1",
          [out.project.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          'select stored_status,total,currency from finance_invoices where legacy_project_id=$1',
          [out.project.id],
        )
      ).rows[0].stored_status,
      'Draft',
    );
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      user,
    ]);
    await client.query('set local role authenticated');
    await client.query('savepoint revoked');
    await assert.rejects(run(payload, key), { code: '42501' });
    await client.query('rollback to savepoint revoked');
  });
  for (const patch of [
    { clientId: 'test-client-b' },
    { projectManagerId: 'unresolved' },
    { templateAssigneeId: '' },
    { projectType: 'Unknown template' },
    { deadline: '2026-01-01' },
    { status: 'Completed' },
    { createInvoice: 'yes' },
    { currency: '' },
    { role: 'Owner' },
    { organizationId: orgB },
    { projectName: { unsafe: 'object' } },
  ])
    await assert.rejects(
      asRole('authenticated', async () => {
        await finance();
        await run({ ...payload, ...patch });
      }),
    );
  await assert.rejects(
    asRole('authenticated', () => run()),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () => run({ ...payload, createInvoice: false }, randomUUID(), orgB)),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () => run()),
    { code: '42501' },
  );
  await asRole('authenticated', async () => {
    await finance();
    await client.query('set local role postgres');
    const count = async () =>
      (
        await client.query(
          "select count(*)::int n from records where coll in('projects','tasks','invoices')",
        )
      ).rows[0].n;
    const before = await count();
    await client.query(
      "create function pg_temp.reject_project_invoice() returns trigger language plpgsql as $$ begin if new.coll='invoices' then raise exception 'synthetic invoice failure';end if;return new;end;$$; create trigger qa_project_invoice_failure before insert on records for each row execute function pg_temp.reject_project_invoice()",
    );
    await client.query('set local role authenticated');
    await client.query('savepoint failure');
    await assert.rejects(run(), /synthetic invoice failure/);
    await client.query('rollback to savepoint failure');
    await client.query('set local role postgres');
    assert.equal(await count(), before);
  });
  const connections = [connect(), connect()],
    key = randomUUID(),
    simple = { ...payload, createInvoice: false, createDefaultTasks: false };
  try {
    const rows = await Promise.all(
      connections.map(async (c) => {
        await c.connect();
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
        const out = (
          await c.query('select create_project_setup_v2($1,$2,$3) result', [
            orgA,
            JSON.stringify(simple),
            key,
          ])
        ).rows[0].result;
        await c.query('commit');
        return out;
      }),
    );
    assert.equal(rows[0].project.id, rows[1].project.id);
    assert.equal(rows.filter((x) => x.replayed).length, 1);
  } finally {
    await Promise.all(connections.map((c) => c.end()));
  }
  console.log(
    'PASS project setup: atomic project/10 assigned dated tasks/draft invoice, concurrent retry dedupe, tenant/role/input/ambiguous-owner denial, full rollback on invoice failure',
  );
}
