import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Run on independent staging only. Every fixture and decision rolls back.
export async function verifyEmployeeRequests(client) {
  const org = crypto.randomUUID(),
    worker = crypto.randomUUID(),
    manager = crypto.randomUUID();
  const workerRole = crypto.randomUUID(),
    managerRole = crypto.randomUUID();
  const tag = 'qa-requests-' + crypto.randomBytes(8).toString('hex');
  const employee = tag + '-employee',
    boss = tag + '-manager';
  await client.query('begin');
  try {
    await client.query(
      "insert into organizations(id,name,slug) values($1,'Isolated request QA',$2)",
      [org, tag],
    );
    for (const [id, role, key] of [
      [worker, workerRole, 'content_creator'],
      [manager, managerRole, 'manager'],
    ]) {
      await client.query('insert into auth.users(id,email) values($1,$2)', [
        id,
        id + '@example.invalid',
      ]);
      await client.query(
        "update profiles set status='Active',identity_status='ACTIVE' where id=$1",
        [id],
      );
      await client.query(
        'insert into organization_roles(id,organization_id,key,name) values($1,$2,$3,$3)',
        [role, org, key],
      );
      await client.query(
        "insert into organization_members(organization_id,user_id,role_id,status,joined_at) values($1,$2,$3,'ACTIVE',now())",
        [org, id, role],
      );
      await client.query(
        "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key in ('requests.read','requests.create','work.read')",
        [role],
      );
    }
    await client.query(
      "insert into records(id,coll,organization_id,data) values($1,'employees',$3,$4),($2,'employees',$3,$5)",
      [
        employee,
        boss,
        org,
        { id: employee, userId: worker, fullName: 'Synthetic employee', managerId: boss },
        { id: boss, userId: manager, fullName: 'Synthetic manager' },
      ],
    );
    await client.query('update profiles set employee_id=$2 where id=$1', [worker, employee]);
    await client.query('update profiles set employee_id=$2 where id=$1', [manager, boss]);
    await client.query('select seed_employee_request_policies_v3($1)', [org]);
    const as = async (user) => {
      await client.query('set local role postgres');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
      await client.query('set local role authenticated');
    };
    await as(worker);
    const submit = async (draft, day, key) =>
      (
        await client.query(
          "select submit_employee_request_v3($1,'general','Synthetic verification','NORMAL',current_date+$2::integer,null,null,null,null,'{\"reason\":\"Synthetic QA only\"}','{}','[]',array[]::uuid[],$3,$4) result",
          [org, day, key, draft],
        )
      ).rows[0].result;
    const direct = await submit(false, 10, tag + '-direct');
    assert.equal(direct.status, 'PENDING_MANAGER');
    assert.equal((await submit(false, 10, tag + '-direct')).id, direct.id);
    await client.query('savepoint self_denial');
    await assert.rejects(
      client.query("select decide_employee_request_v3($1,$2,$3,'APPROVE','Synthetic','{}')", [
        org,
        direct.id,
        direct.version,
      ]),
      { code: '42501' },
    );
    await client.query('rollback to savepoint self_denial');
    await as(manager);
    const approved = (
      await client.query(
        "select decide_employee_request_v3($1,$2,$3,'APPROVE','Synthetic','{}') result",
        [org, direct.id, direct.version],
      )
    ).rows[0].result;
    assert.equal(approved.status, 'APPROVED');
    await as(worker);
    const draft = await submit(true, 11, tag + '-draft');
    assert.equal(draft.status, 'DRAFT');
    const sent = (
      await client.query('select submit_saved_employee_request_v3($1,$2,$3,$4) result', [
        org,
        draft.id,
        draft.version,
        tag + '-send',
      ])
    ).rows[0].result;
    assert.equal(sent.status, 'PENDING_MANAGER');
    for (const scope of ['MINE', 'AUTHORIZED', 'QUEUE', 'TEAM_CALENDAR']) {
      const listed = (
        await client.query('select list_employee_requests_v3($1,$2) result', [org, scope])
      ).rows[0].result;
      assert.equal(listed.total, ['MINE', 'AUTHORIZED'].includes(scope) ? 2 : 0);
      assert.equal(listed.items.length, listed.total);
    }
    const detail = (
      await client.query('select get_employee_request_v3($1,$2) result', [org, direct.id])
    ).rows[0].result;
    assert.equal(detail.request.status, 'APPROVED');
    assert.ok(detail.timeline.length >= 2);
    await as(manager);
    const queue = (await client.query("select list_employee_requests_v3($1,'QUEUE') result", [org]))
      .rows[0].result;
    assert.equal(queue.total, 1);
    assert.equal(queue.items[0].id, draft.id);
    console.log(
      'PASS employee requests: direct submission, retry, self-decision denial, manager approval, saved-draft submission, authorized lists and persisted timeline',
    );
  } finally {
    await client.query('rollback');
  }
}
