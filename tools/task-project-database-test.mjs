import assert from 'node:assert/strict';
export async function verifyTaskProjectRelationships({ client, orgA, orgB, user, asRole }) {
  const task = {
    title: 'Synthetic relational task',
    clientId: 'test-client-a',
    projectId: 'workflow-project',
    assignedTo: 'workflow-employee',
    status: 'Backlog',
  };
  const reject = async (fn, pattern) => {
    await client.query('savepoint relationship');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint relationship');
  };
  await asRole('authenticated', async () => {
    await client.query(
      "insert into records(id,coll,organization_id,data) values('relation-task','tasks',$1,$2)",
      [orgA, JSON.stringify(task)],
    );
    const read = async () =>
      (await client.query("select * from work_tasks where legacy_record_id='relation-task'"))
        .rows[0];
    assert.equal((await read()).project_reference_id, 'workflow-project');
    await reject(
      () =>
        client.query(
          "update records set data=jsonb_set(data,'{projectId}','\"missing-project\"') where id='relation-task'",
        ),
      /task_project_relationship_review_required/,
    );
    await reject(
      () => client.query("update records set coll='notes' where id='relation-task'"),
      /task_projection_identity_locked/,
    );
    await reject(
      () =>
        client.query(
          "update records set data=jsonb_set(data,'{clientId}','\"test-client-b\"') where id='relation-task'",
        ),
      /task_project_relationship_review_required/,
    );
    await client.query('set local role postgres');
    await reject(
      () =>
        client.query(
          "update records set data=jsonb_set(data,'{clientId}','\"test-client-b\"') where id='workflow-project'",
        ),
      /project_task_relationship_locked/,
    );
    await reject(
      () =>
        client.query("update records set organization_id=$1 where id='workflow-project'", [orgB]),
      /relationship_locked/,
    );
    await reject(() => client.query("delete from records where id='workflow-project'"), {
      code: '23503',
    });
    // A representative unresolved legacy task is preserved, not assigned a guessed project.
    await client.query("select set_config('request.jwt.claim.role','service_role',true)");
    await client.query(
      "insert into records(id,coll,organization_id,data) values('relation-legacy','tasks',$1,$2)",
      [orgA, JSON.stringify({ ...task, projectId: 'unresolved' })],
    );
    assert.equal(
      (
        await client.query(
          "select project_reference_id from work_tasks where legacy_record_id='relation-legacy'",
        )
      ).rows[0].project_reference_id,
      null,
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from task_projection_issues_v2 where legacy_record_id='relation-legacy' and issue_code='PROJECT_RELATIONSHIP_REVIEW_REQUIRED' and resolved_at is null",
        )
      ).rows[0].n,
      1,
    );
    await client.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await client.query('set local role authenticated');
    await client.query(
      'update records set data=data||\'{"title":"Preserved historical task"}\' where id=\'relation-legacy\'',
    );
    const id = (
      await client.query(
        "select id,version from work_tasks where legacy_record_id='relation-legacy'",
      )
    ).rows[0];
    await reject(
      () =>
        client.query("select change_task_status_v2($1,$2,$3,'In Progress',null)", [
          orgA,
          id.id,
          id.version,
        ]),
      /task_project_relationship_review_required/,
    );
    await client.query(
      "update records set data=jsonb_set(data,'{projectId}','\"workflow-project\"') where id='relation-legacy'",
    );
    await client.query('set local role postgres');
    assert.ok(
      (
        await client.query(
          "select resolved_at from task_projection_issues_v2 where legacy_record_id='relation-legacy' and issue_code='PROJECT_RELATIONSHIP_REVIEW_REQUIRED'",
        )
      ).rows[0].resolved_at,
    );
    assert.equal(
      (await client.query("select data->>'title' title from records where id='relation-legacy'"))
        .rows[0].title,
      'Preserved historical task',
    );
    assert.equal((await read()).assigned_user_id, user);
  });
  console.log(
    'PASS task/project references: verified tenant/client FK chain, rejected raw bypass/identity drift, preserved unresolved legacy rows, blocked execution until explicit repair',
  );
}
