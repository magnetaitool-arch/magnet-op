import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyWorkflowAuthority({ client, orgA, orgB, user, asRole }) {
  const read = async (id) =>
    (await client.query('select workflow_readiness_v2($1,$2) result', [orgA, id])).rows[0].result;
  const advance = async (id, stage, key = randomUUID(), org = orgA) =>
    (await client.query('select advance_workflow_v2($1,$2,$3,$4) result', [org, id, stage, key]))
      .rows[0].result;
  const fixture = async (stage) => {
    await client.query('set local role postgres');
    await client.query("select set_config('app.workflow_command','1',true)");
    await client.query(
      'insert into records(id,coll,organization_id,data) values(\'authority-workflow\',\'workflows\',$1,\'{"clientId":"test-client-a","stage":2,"stageHistory":[]}\')',
      [orgA],
    );
    await client.query(
      "update records set data=data||jsonb_build_object('stage',$1::integer) where id='authority-workflow'",
      [stage],
    );
    await client.query("select set_config('app.workflow_command','',true)");
    await client.query('set local role authenticated');
    return 'authority-workflow';
  };
  await asRole('authenticated', async () => {
    const start = async () =>
      (await client.query("select start_workflow_v2($1,'test-client-a') result", [orgA])).rows[0]
        .result;
    const out = await start();
    assert.equal(out.workflow.stage, 2);
    assert.equal((await start()).workflow.id, out.workflow.id);
    assert.equal((await read(out.workflow.id)).ready, false);
    await client.query('set local role postgres');
    await client.query(
      'update records set data=data||\'{"mainContactName":"","mainContactEmail":"contact@example.invalid","serviceType":"Branding"}\' where id=\'test-client-a\'',
    );
    await client.query('set local role authenticated');
    assert.equal((await read(out.workflow.id)).ready, true);
    const key = randomUUID();
    assert.equal((await advance(out.workflow.id, 2, key)).stage, 3);
    assert.equal((await advance(out.workflow.id, 2, key)).replayed, true);
    await client.query('savepoint stale');
    await assert.rejects(advance(out.workflow.id, 2), { code: '40001' });
    await client.query('rollback to savepoint stale');
    await client.query("select set_config('app.workflow_command','',true)");
    await client.query('set local role postgres');
    await client.query('savepoint bypass');
    await assert.rejects(
      client.query('update records set data=data||\'{"stage":15}\' where id=$1', [out.workflow.id]),
      { code: '42501' },
    );
    await client.query('rollback to savepoint bypass');
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='WORKFLOW_ADVANCED' and entity_id=$1",
          [out.workflow.id],
        )
      ).rows[0].n,
      1,
    );
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      user,
    ]);
    await client.query('set local role authenticated');
    await client.query('savepoint revoked');
    await assert.rejects(advance(out.workflow.id, 2, key), { code: '42501' });
    await client.query('rollback to savepoint revoked');
  });
  for (const stage of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    await asRole('authenticated', async () => {
      const id = await fixture(stage);
      await client.query('set local role postgres');
      if (stage === 3)
        await client.query(
          'insert into records(id,coll,organization_id,data) values(\'authority-proposal\',\'proposals\',$1,\'{"clientId":"test-client-a","status":"Approved Internally"}\')',
          [orgA],
        );
      if (stage === 6)
        await client.query(
          'insert into records(id,coll,organization_id,data) values(\'authority-collection\',\'collections\',$1,\'{"clientId":"test-client-a","status":"Collected","amount":200}\')',
          [orgA],
        );
      if (stage === 7)
        await client.query(
          'insert into records(id,coll,organization_id,data) values(\'authority-asset\',\'clientAssets\',$1,\'{"clientId":"test-client-a","accessStatus":"Requested"}\')',
          [orgA],
        );
      if (stage === 14)
        await client.query(
          'insert into records(id,coll,organization_id,data) values(\'authority-report\',\'reports\',$1,\'{"clientId":"test-client-a","status":"Draft"}\')',
          [orgA],
        );
      await client.query('set local role authenticated');
      assert.equal((await read(id)).ready, false, 'missing evidence at stage ' + stage);
      assert.equal((await advance(id, stage)).ok, false);
      assert.equal((await read(id)).stage, stage);
    });
  for (const stage of [7, 8, 11, 12, 13, 14])
    await asRole('authenticated', async () => {
      const id = await fixture(stage);
      await client.query('set local role postgres');
      if (stage === 7)
        await client.query(
          'update records set data=data||\'{"onboarding":[{"done":true}]}\' where id=\'test-client-a\'',
        );
      else if (stage === 8)
        await client.query(
          'insert into records(id,coll,organization_id,data) values (\'authority-project\',\'projects\',$1,\'{"clientId":"test-client-a","projectManagerId":"workflow-employee","startDate":"2026-09-01","deadline":"2026-10-01"}\')',
          [orgA],
        );
      else
        await client.query(
          "insert into records(id,coll,organization_id,data) values ('authority-ready',$1,$2,$3)",
          [
            stage === 14 ? 'reports' : 'deliverables',
            orgA,
            JSON.stringify({
              clientId: 'test-client-a',
              status:
                stage === 11
                  ? 'Internal Review'
                  : stage === 12
                    ? 'Client Review'
                    : stage === 13
                      ? 'Delivered'
                      : 'Sent',
              approvalStatus: 'Approved',
            }),
          ],
        );
      await client.query('set local role authenticated');
      assert.equal((await advance(id, stage)).stage, stage + 1);
    });
  await assert.rejects(
    asRole('authenticated', () => advance('missing', 2, randomUUID(), orgB)),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () => read('missing')),
    { code: '42501' },
  );
  console.log(
    'PASS workflow authority: canonical prerequisites, draft/internal approval/collection/requested-access denial, fresh role checks, retry dedupe, stale write and generic stage bypass denial',
  );
}
