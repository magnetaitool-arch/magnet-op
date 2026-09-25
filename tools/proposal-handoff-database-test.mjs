import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyProposalHandoff({ client, orgA, orgB, user, role, asRole }) {
  const command = async (id, org = orgA) =>
    (await client.query('select handoff_accepted_proposal_v2($1,$2) result', [org, id])).rows[0]
      .result;
  const setup = async (kind = 'lead') => {
    await client.query('set local role postgres');
    await client.query(
      "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='approvals.manage' on conflict do nothing",
      [role],
    );
    await client.query(
      'insert into records(id,coll,organization_id,data) values (\'handoff-lead\',\'leads\',$1,\'{"name":"Synthetic onboarding lead","status":"Negotiation"}\')',
      [orgA],
    );
    const data = {
      title: 'Onboarding scope',
      scope: 'Agreed strategy discovery',
      currency: 'EGP',
      price: 10000,
      issueDate: '2026-01-01',
      validUntil: '2099-12-31',
    };
    if (kind !== 'client') data.leadId = 'handoff-lead';
    if (kind !== 'lead') data.clientId = 'test-client-a';
    await client.query(
      "insert into records(id,coll,organization_id,data) values ('handoff-proposal','proposals',$1,$2)",
      [orgA, JSON.stringify(data)],
    );
    await client.query('set local role authenticated');
    const hash = (
      await client.query("select get_proposal_revisions_v2($1,'handoff-proposal') result", [orgA])
    ).rows[0].result.currentHash;
    let view = (
      await client.query("select create_proposal_revision_v2($1,'handoff-proposal',$2,$3) result", [
        orgA,
        hash,
        randomUUID(),
      ])
    ).rows[0].result;
    for (const action of ['REVIEW', 'APPROVE', 'RECORD_SENT', 'RECORD_ACCEPTED'])
      view = (
        await client.query('select transition_proposal_revision_v2($1,$2,$3,$4,$5,$6) result', [
          orgA,
          view.revisions[0].id,
          view.revisions[0].version,
          action,
          'Synthetic client response reference QA',
          randomUUID(),
        ])
      ).rows[0].result;
    return view.revisions[0].id;
  };
  for (const kind of ['lead', 'client'])
    await asRole('authenticated', async () => {
      const id = await setup(kind);
      await client.query('set local role postgres');
      const before = (await client.query('select count(*)::int n from client_accounts')).rows[0].n;
      await client.query('set local role authenticated');
      const result = await command(id);
      assert.equal(result.ok, true);
      assert.equal((await command(id)).handoffId, result.handoffId);
      assert.equal((await command(id)).replayed, true);
      const reloaded = (
        await client.query("select get_proposal_revisions_v2($1,'handoff-proposal') result", [orgA])
      ).rows[0].result;
      assert.equal(reloaded.handoffs[0].handoffId, result.handoffId);
      assert.equal(reloaded.handoffs[0].clientId, result.clientId);

      await client.query('set local role postgres');
      assert.equal(
        (await client.query('select count(*)::int n from client_accounts')).rows[0].n,
        before + (kind === 'lead' ? 1 : 0),
      );
      assert.equal(
        (await client.query('select data from records where id=$1', [result.workflowId])).rows[0]
          .data.stage,
        2,
        'execution is not started',
      );
      assert.equal(
        (
          await client.query(
            'select count(*)::int n from proposal_handoffs_v2 where revision_id=$1',
            [id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await client.query(
            "select count(*)::int n from audit_events where action='PROPOSAL_DISCOVERY_HANDOFF' and entity_id=$1",
            [id],
          )
        ).rows[0].n,
        1,
      );
      if (kind === 'lead')
        assert.equal(
          (await client.query("select stage from crm_leads where legacy_record_id='handoff-lead'"))
            .rows[0].stage,
          'Won',
        );
      await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
        user,
      ]);
      await client.query('set local role authenticated');
      await client.query('savepoint denied_replay');
      await assert.rejects(command(id), { code: '42501' });
      await client.query('rollback to savepoint denied_replay');
    });
  for (const failure of [
    'ambiguous',
    'stale',
    'tenant',
    'workflow',
    'not_accepted',
    'late_failure',
  ])
    await asRole('authenticated', async () => {
      const id = await setup(
        failure === 'ambiguous' ? 'both' : failure === 'workflow' ? 'client' : 'lead',
      );
      await client.query('set local role postgres');
      if (failure === 'stale')
        await client.query(
          "update records set data=data||'{\"price\":9999}' where id='handoff-proposal'",
        );
      if (failure === 'not_accepted')
        await client.query("update proposal_revisions_v2 set state='SENT' where id=$1", [id]);
      if (failure === 'workflow')
        await client.query(
          "insert into records(id,coll,organization_id,data) values ('handoff-wf-a','workflows',$1,'{\"clientId\":\"test-client-a\"}'),('handoff-wf-b','workflows',$1,'{\"clientId\":\"test-client-a\"}')",
          [orgA],
        );
      if (failure === 'late_failure')
        await client.query(
          `create function pg_temp.reject_handoff() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure'; end; $$; create trigger qa_handoff_failure before insert on proposal_handoffs_v2 for each row execute function pg_temp.reject_handoff()`,
        );
      const before = (await client.query('select count(*)::int n from client_accounts')).rows[0].n;
      const stageBefore = (
        await client.query("select stage from crm_leads where legacy_record_id='handoff-lead'")
      ).rows[0].stage;
      await client.query('set local role authenticated');
      await client.query('savepoint failed_handoff');
      await assert.rejects(command(id, failure === 'tenant' ? orgB : orgA));
      await client.query('rollback to savepoint failed_handoff');
      await client.query('set local role postgres');
      assert.equal(
        (await client.query("select stage from crm_leads where legacy_record_id='handoff-lead'"))
          .rows[0].stage,
        stageBefore,
      );
      assert.equal(
        (await client.query('select count(*)::int n from client_accounts')).rows[0].n,
        before,
      );
      assert.equal(
        (
          await client.query(
            'select count(*)::int n from proposal_handoffs_v2 where revision_id=$1',
            [id],
          )
        ).rows[0].n,
        0,
      );
    });
  await assert.rejects(
    asRole('anon', () => command(randomUUID())),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () =>
      client.query('insert into proposal_handoffs_v2(id) values(gen_random_uuid())'),
    ),
    { code: '42501' },
  );
  console.log(
    'PASS accepted proposal handoff: lead/client reuse, Won/discovery atomic linkage, replay, fresh authority, tenant/ambiguity/stale/nonaccepted/direct-write denial',
  );
}
