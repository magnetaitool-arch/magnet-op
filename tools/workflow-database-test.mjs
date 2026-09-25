import assert from 'node:assert/strict';
// Real database workflow segments. These do not impersonate hosted Auth or publishing.
export async function verifyWorkflowSegments({ client, orgA, orgB, user, role, asRole }) {
  await client.query(
    "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key in ('work.manage','work.read','clients.manage','clients.read') on conflict do nothing",
    [role],
  );
  await client.query(
    'insert into records(id,coll,organization_id,data) values (\'workflow-employee\',\'employees\',$1,\'{"fullName":"Synthetic employee"}\'),(\'workflow-project\',\'projects\',$1,\'{"name":"Synthetic project","clientId":"test-client-a"}\'),(\'workflow-lead\',\'leads\',$1,\'{"name":"Synthetic lead","status":"New Lead"}\')',
    [orgA],
  );
  await client.query("update profiles set employee_id='workflow-employee' where id=$1", [user]);
  await asRole('authenticated', async () => {
    const other = '00000000-0000-4000-8000-000000000002';
    assert.equal(
      (await client.query("select task_user_for_employee_v2('workflow-employee') as id")).rows[0]
        .id,
      user,
    );
    assert.equal(
      (
        await client.query(
          "select task_is_current_assignee_v2($1,'workflow-employee') as allowed",
          [other],
        )
      ).rows[0].allowed,
      false,
    );
    await client.query('set local role postgres');
    await client.query("update profiles set employee_id='workflow-employee' where id=$1", [other]);
    await client.query('set local role authenticated');
    assert.equal(
      (await client.query("select task_user_for_employee_v2('workflow-employee') as id")).rows[0]
        .id,
      null,
    );
    assert.equal(
      (
        await client.query(
          "select task_is_current_assignee_v2(null,'workflow-employee') as allowed",
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await client.query(
          "select task_is_current_assignee_v2($1,'workflow-employee') as allowed",
          [user],
        )
      ).rows[0].allowed,
      true,
    );
    await client.query('set local role postgres');
    await client.query('update profiles set employee_id=null where id=$1', [other]);
    await client.query(
      "insert into legacy_identity_links(legacy_account_row_id,auth_user_id,employee_record_id,link_status) values ('synthetic-conflict',$1,'workflow-employee','CONFIRMED')",
      [other],
    );
    await client.query('set local role authenticated');
    assert.equal(
      (await client.query("select task_user_for_employee_v2('workflow-employee') as id")).rows[0]
        .id,
      null,
    );
    assert.equal(
      (
        await client.query(
          "select task_is_current_assignee_v2(null,'workflow-employee') as allowed",
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (await client.query("select task_user_for_employee_v2('') as id")).rows[0].id,
      null,
    );
  });
  const clientId = (
    await client.query("select id from client_accounts where legacy_record_id='test-client-a'")
  ).rows[0].id;
  const createTask = async () =>
    (
      await client.query(
        "select create_task_v2($1,'Execute approved brief',$2,'workflow-project','workflow-employee') as result",
        [orgA, clientId],
      )
    ).rows[0].result;
  await asRole('authenticated', async () => {
    const result = await createTask();
    await client.query('set local role postgres');
    await client.query('update work_tasks set assigned_user_id=$1 where id=$2', [
      '00000000-0000-4000-8000-000000000002',
      result.task.id,
    ]);
    await client.query(
      "delete from role_capabilities where role_id=$1 and capability_id in (select id from capabilities where key='work.manage')",
      [role],
    );
    await client.query('set local role authenticated');
    assert.equal(
      (await client.query('select * from work_tasks where id=$1', [result.task.id])).rowCount,
      0,
    );
    assert.equal(
      (await client.query('select get_task_v2($1,$2) as result', [orgA, result.task.id])).rows[0]
        .result.ok,
      false,
    );
  });
  console.log(
    'PASS ambiguous employee identity fails closed; explicit assignee wins in helper, RLS and task detail RPC',
  );
  await asRole('authenticated', async () => {
    assert.equal(
      (await client.query('select current_member_role_key($1) as role', [orgA])).rows[0].role,
      'test_reader',
    );
    const result = await createTask();
    assert.equal(result.ok, true);
    assert.ok(result.task.id);
    const task = (await client.query('select * from work_tasks where id=$1', [result.task.id]))
      .rows[0];
    assert.equal(task.assigned_user_id, user);
    assert.equal(task.organization_id, orgA);
    const notification = (
      await client.query(
        "select * from user_notifications_v2 where entity_id=$1 and notification_type='TASK_ASSIGNED'",
        [task.id],
      )
    ).rows[0];
    assert.equal(notification.recipient_user_id, user);
    await client.query('select mark_notifications_read_v2($1,$2)', [orgA, notification.id]);
    assert.ok(
      (
        await client.query('select read_at from user_notifications_v2 where id=$1', [
          notification.id,
        ])
      ).rows[0].read_at,
    );
    await client.query("select change_task_status_v2($1,$2,$3,'In Progress')", [
      orgA,
      task.id,
      task.version,
    ]);
    const progressed = (
      await client.query('select version,status from work_tasks where id=$1', [task.id])
    ).rows[0];
    assert.equal(progressed.status, 'In Progress');
    assert.ok(progressed.version > task.version);
    await client.query("select change_task_status_v2($1,$2,$3,'Internal Review')", [
      orgA,
      task.id,
      progressed.version,
    ]);
    assert.equal(
      (await client.query('select status from work_tasks where id=$1', [task.id])).rows[0].status,
      'Internal Review',
    );
    // Removing claims models database access after logout, not the HTTP logout flow.
    await client.query("select set_config('request.jwt.claim.sub','',true)");
    assert.equal(
      (await client.query('select * from work_tasks where id=$1', [task.id])).rowCount,
      0,
    );
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    assert.equal(
      (await client.query('select * from work_tasks where id=$1', [task.id])).rowCount,
      1,
    );
  });
  for (const suspension of [true, false])
    await assert.rejects(
      asRole('authenticated', async () => {
        const result = await createTask();
        await client.query('set local role postgres');
        if (suspension)
          await client.query(
            "update organization_members set status='SUSPENDED' where user_id=$1",
            [user],
          );
        else
          await client.query(
            "delete from role_capabilities where role_id=$1 and capability_id in (select id from capabilities where key like 'work.%')",
            [role],
          );
        await client.query('set local role authenticated');
        await client.query("select change_task_status_v2($1,$2,$3,'In Progress')", [
          orgA,
          result.task.id,
          result.task.version,
        ]);
      }),
      { code: '42501' },
    );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query(
        "select create_task_v2($1,'Cross-tenant task',$2,'workflow-project','workflow-employee')",
        [orgB, clientId],
      );
    }),
    { code: '42501' },
  );
  await asRole('authenticated', async () => {
    for (const stage of ['Contacted', 'Proposal Sent', 'Won']) {
      const response = (
        await client.query('select change_crm_lead_stage($1,$2,$3,$4) as result', [
          orgA,
          'workflow-lead',
          stage,
          'Synthetic workflow checkpoint',
        ])
      ).rows[0].result;
      assert.equal(response.ok, true);
    }
    assert.equal(
      (await client.query("select stage from crm_leads where legacy_record_id='workflow-lead'"))
        .rows[0].stage,
      'Won',
    );
    assert.equal(
      (await client.query('select count(*)::int as n from crm_lead_notes')).rows[0].n,
      3,
    );
  });
  console.log(
    'PASS workflow segments: role/workspace → assigned task → notification → execution/review → claims removal/restoration; CRM stages with notes',
  );
  console.log(
    'NOT VERIFIED end-to-end: hosted login/logout, follow-up/proposal conversion, revision approval, publishing and reporting',
  );
}
