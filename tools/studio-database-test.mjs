import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyStudio({
  client,
  orgA,
  orgB,
  user,
  role,
  asRole,
  clientRecord = 'test-client-a',
  projectRecord = 'workflow-project',
  employeeRecord = 'workflow-employee',
}) {
  const reject = async (fn, pattern) => {
    await client.query('savepoint studio_negative');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint studio_negative');
  };
  await asRole('authenticated', async () => {
    const account = (
      await client.query('select id from client_accounts where legacy_record_id=$1', [clientRecord])
    ).rows[0].id;
    const task = (
      await client.query("select create_task_v2($1,'Studio fixture',$2,$3,$4) result", [
        orgA,
        account,
        projectRecord,
        employeeRecord,
      ])
    ).rows[0].result.task;
    const id = randomUUID(),
      key = randomUUID();
    let rev = 0;
    const command = async (
      action,
      payload = { title: 'Studio brief', answers: { objective: 'Launch' } },
      cmd = randomUUID(),
      org = orgA,
    ) =>
      (
        await client.query(
          'select studio_command_v2($1,$2,$3,$4,null,$5,$6,$7,null,$8,$9) result',
          [org, id, task.id, 'brief', rev, action, payload, 'Clear review note', cmd],
        )
      ).rows[0].result;
    const first = await command('SAVE', undefined, key);
    assert.equal(
      (await client.query('select list_studio_v2($1) result', [orgA])).rows[0].result.documents
        .length,
      1,
    );
    assert.equal(first.document.revision, 1);
    assert.equal(first.document.status, 'DRAFT');
    assert.equal((await command('SAVE', undefined, key)).replayed, true);
    await reject(() => command('SAVE'), /studio_revision_conflict/);
    await reject(() => command('SAVE', undefined, randomUUID(), orgB), { code: '42501' });
    rev = 1;
    await command('SUBMIT');
    await reject(() => command('SAVE'), /studio_revision_locked/);
    await reject(() => command('APPROVE'), /studio_independent_reviewer_required/);
    await reject(() => client.query('select * from studio_versions_v2'), { code: '42501' });
    await client.query('set local role postgres');
    await client.query(
      "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='approvals.manage' on conflict do nothing",
      [role],
    );
    const reviewer = randomUUID();
    await client.query('insert into auth.users(id,email) values($1,$2)', [
      reviewer,
      reviewer + '@studio.invalid',
    ]);
    await client.query("update profiles set identity_status='ACTIVE' where id=$1", [reviewer]);
    await client.query(
      "insert into organization_members(organization_id,user_id,role_id,status,joined_at) values($1,$2,$3,'ACTIVE',now())",
      [orgA, reviewer, role],
    );
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [reviewer]);
    await client.query('set local role authenticated');
    await command('REVISION');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    const second = await command('SAVE', {
      title: 'Revised brief',
      answers: { objective: 'Approved direction' },
    });
    assert.equal(second.versions.length, 2);
    rev = 2;
    await command('SUBMIT');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [reviewer]);
    assert.equal((await command('APPROVE')).document.status, 'APPROVED');
    assert.equal((await command('FINAL')).document.status, 'FINAL');
    await reject(() => command('SAVE'), /studio_revision_locked/);
    const reopened = (await client.query('select get_studio_v2($1,$2) result', [orgA, id])).rows[0]
      .result;
    assert.equal(reopened.versions[1].payload.title, 'Studio brief');
    assert.equal(reopened.events.length, 7);
    const assetId = randomUUID();
    const asset = (
      await client.query(
        "select studio_command_v2($1,$2,$3,'design',null,0,'SAVE',$4,null,null,$5) result",
        [
          orgA,
          assetId,
          task.id,
          { title: 'Design version', body: 'Synthetic creative', briefId: id },
          randomUUID(),
        ],
      )
    ).rows[0].result;
    assert.equal(asset.document.brief_revision, 2);
    assert.equal(asset.document.brief_document_id, id);
    await reject(
      () =>
        client.query("select studio_command_v2($1,$2,$3,'video',null,0,'SAVE',$4,null,null,$5)", [
          orgA,
          randomUUID(),
          task.id,
          { title: 'Missing brief' },
          randomUUID(),
        ]),
      /studio_brief_required/,
    );
    await client.query('set local role postgres');
    await client.query(
      "delete from role_capabilities where role_id=$1 and capability_id=(select id from capabilities where key='approvals.manage')",
      [role],
    );
    await client.query('set local role authenticated');
    await reject(() => client.query('select get_studio_v2($1,$2)', [orgA, id]), { code: '42501' });
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    assert.equal(
      (await client.query('select get_studio_v2($1,$2) result', [orgA, id])).rows[0].result.ok,
      true,
    );
    await client.query('set local role postgres');
    const hadClientRead = (
      await client.query(
        "delete from role_capabilities where role_id=$1 and capability_id=(select id from capabilities where key='clients.read') returning capability_id",
        [role],
      )
    ).rows;
    const campaign = 'studio-campaign-' + randomUUID();
    const unrelated = 'studio-campaign-' + randomUUID();
    await client.query(
      "insert into records(id,coll,organization_id,data) values($1,'campaigns',$3,$4),($2,'campaigns',$3,$5)",
      [
        campaign,
        unrelated,
        orgA,
        { name: 'Assigned campaign', clientId: clientRecord },
        { name: 'Unrelated campaign', clientId: 'not-this-client' },
      ],
    );
    await client.query('set local role authenticated');
    assert.equal(
      (await client.query("select has_org_capability($1,'clients.read') allowed", [orgA])).rows[0]
        .allowed,
      false,
    );
    const campaigns = (await client.query('select list_studio_v2($1) result', [orgA])).rows[0]
      .result.campaigns;
    assert.ok(campaigns.some((c) => c.id === campaign));
    assert.ok(!campaigns.some((c) => c.id === unrelated));
    const saveCampaign = (campaignId) =>
      client.query(
        "select studio_command_v2($1,$2,$3,'report',$4,0,'SAVE',$5,null,null,$6) result",
        [orgA, randomUUID(), task.id, campaignId, { title: 'Assigned report' }, randomUUID()],
      );
    assert.equal((await saveCampaign(campaign)).rows[0].result.ok, true);
    await reject(() => saveCampaign(unrelated), /studio_campaign_invalid/);
    await client.query('set local role postgres');
    await client.query(
      'update records set deleted_at=now(),data=data||\'{"_del":true}\' where id=$1',
      [campaign],
    );
    await client.query('set local role authenticated');
    await reject(() => saveCampaign(campaign), /studio_campaign_invalid/);
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [reviewer]);
    await reject(() => saveCampaign(campaign), { code: '42501' });
    await client.query('set local role postgres');
    for (const capability of hadClientRead)
      await client.query('insert into role_capabilities(role_id,capability_id) values($1,$2)', [
        role,
        capability.capability_id,
      ]);
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [reviewer]);
    await client.query('set local role postgres');
    await reject(
      () => client.query("update studio_versions_v2 set payload='{}' where document_id=$1", [id]),
      /immutable/,
    );
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      reviewer,
    ]);
    await client.query('set local role authenticated');
    await reject(() => client.query('select get_studio_v2($1,$2)', [orgA, id]), { code: '42501' });
  });
  await assert.rejects(
    asRole('anon', () => client.query('select list_studio_v2($1)', [orgA])),
    { code: '42501' },
  );
  console.log(
    'PASS Studio persistence, replay/conflict, immutable versions, revision/review/final, self-review/tenant/anon/suspension/direct-write isolation',
  );
}
