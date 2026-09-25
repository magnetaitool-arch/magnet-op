import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyProposalRevisions({ client, orgA, orgB, user, role, asRole, connect }) {
  const proposalId = 'workflow-proposal';
  await client.query(
    "insert into records(id,coll,organization_id,data) values($1,'proposals',$2,jsonb_build_object('title','Synthetic scope','leadId','workflow-lead','clientId','test-client-a','scope','Brand strategy and launch plan','currency','EGP','price',12000,'issueDate',current_date,'validUntil',current_date+30,'status','Draft'))",
    [proposalId, orgA],
  );
  const get = async () =>
    (await client.query('select get_proposal_revisions_v2($1,$2) result', [orgA, proposalId]))
      .rows[0].result;
  const create = async (key = randomUUID(), hash) =>
    (
      await client.query('select create_proposal_revision_v2($1,$2,$3,$4) result', [
        orgA,
        proposalId,
        hash || (await get()).currentHash,
        key,
      ])
    ).rows[0].result;
  const transition = async (r, action, evidence = null, key = randomUUID()) =>
    (
      await client.query('select transition_proposal_revision_v2($1,$2,$3,$4,$5,$6) result', [
        orgA,
        r.id,
        r.version,
        action,
        evidence,
        key,
      ])
    ).rows[0].result;
  await asRole('authenticated', async () => {
    const key = randomUUID();
    const first = await create(key);
    const revision = first.revisions[0];
    assert.equal(revision.revision, 1);
    assert.equal(revision.snapshot.preparedFor, 'test-client-a');
    assert.equal(revision.snapshot.price, 12000);
    assert.match(revision.content_hash, /^[a-f0-9]{64}$/);
    assert.equal((await create(key, revision.source_hash)).createdRevisionId, revision.id);
    let response = await transition(revision, 'REVIEW');
    assert.equal(response.revisions[0].state, 'REVIEW');
    await client.query('savepoint cannot_approve');
    await assert.rejects(transition(response.revisions[0], 'APPROVE'), { code: '42501' });
    await client.query('rollback to savepoint cannot_approve');
    await client.query('set local role postgres');
    await client.query(
      "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='approvals.manage' on conflict do nothing",
      [role],
    );
    await client.query('set local role authenticated');
    response = await transition(response.revisions[0], 'APPROVE');
    assert.equal(response.revisions[0].state, 'APPROVED');
    await client.query('savepoint no_evidence');
    await assert.rejects(transition(response.revisions[0], 'RECORD_SENT'));
    await client.query('rollback to savepoint no_evidence');
    response = await transition(
      response.revisions[0],
      'RECORD_SENT',
      'Sent exact revision by email; synthetic reference QA-1',
    );
    const acceptKey = randomUUID(),
      sent = response.revisions[0];
    response = await transition(
      sent,
      'RECORD_ACCEPTED',
      'Client acceptance email reference QA-2',
      acceptKey,
    );
    assert.equal(response.revisions[0].state, 'ACCEPTED');
    assert.equal(response.record.status, 'Accepted');
    assert.equal(
      (
        await transition(
          sent,
          'RECORD_ACCEPTED',
          'Client acceptance email reference QA-2',
          acceptKey,
        )
      ).replayed,
      true,
    );
    assert.equal(response.events.length, 5);
    await client.query("select set_config('app.proposal_revision_command','',true)");
    await client.query('savepoint bypass');
    await assert.rejects(
      client.query('update records set data=data||\'{"status":"Sent"}\' where id=$1', [proposalId]),
      { code: '42501' },
    );
    await client.query('rollback to savepoint bypass');
    await client.query('set local role postgres');
    await client.query('savepoint immutable');
    await assert.rejects(
      client.query("update proposal_revisions_v2 set snapshot='{}' where id=$1", [revision.id]),
      { code: '42501' },
    );
    await client.query('rollback to savepoint immutable');
  });
  await asRole('authenticated', async () => {
    const first = (await create()).revisions[0];
    await client.query('update records set data=data||\'{"price":15000}\' where id=$1', [
      proposalId,
    ]);
    await client.query('savepoint stale');
    await assert.rejects(transition(first, 'REVIEW'), { code: '40001' });
    await client.query('rollback to savepoint stale');
    const next = await create();
    assert.equal(next.revisions[0].revision, 2);
    assert.equal(next.revisions[0].snapshot.price, 15000);
    assert.equal(next.revisions[1].snapshot.price, 12000);
    assert.equal(next.revisions[1].state, 'SUPERSEDED');
    assert.ok(next.events.some((e) => e.to_state === 'SUPERSEDED'));
  });
  await assert.rejects(asRole('anon', get), { code: '42501' });
  await assert.rejects(
    asRole('authenticated', () =>
      client.query('select get_proposal_revisions_v2($1,$2)', [orgB, proposalId]),
    ),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query(
        'update records set data=data||\'{"clientId":"test-client-b"}\' where id=$1',
        [proposalId],
      );
      await create();
    }),
  );
  await assert.rejects(
    asRole('authenticated', () =>
      client.query('insert into proposal_revisions_v2(id) values(gen_random_uuid())'),
    ),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      const key = randomUUID(),
        result = await create(key);
      await client.query('set local role postgres');
      await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
        user,
      ]);
      await client.query('set local role authenticated');
      await create(key, result.currentHash);
    }),
    { code: '42501' },
  );
  const connections = [connect(), connect()],
    key = randomUUID(),
    hash = (
      await client.query('select proposal_content_hash_v2(data) hash from records where id=$1', [
        proposalId,
      ])
    ).rows[0].hash;
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
        const result = (
          await c.query('select create_proposal_revision_v2($1,$2,$3,$4) result', [
            orgA,
            proposalId,
            hash,
            key,
          ])
        ).rows[0].result;
        await c.query('commit');
        return result;
      }),
    );
    assert.equal(results[0].createdRevisionId, results[1].createdRevisionId);
    assert.equal(
      (await client.query('select count(*)::int n from proposal_revisions_v2')).rows[0].n,
      1,
    );
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
    'PASS proposal revisions: immutable snapshots, explicit relations, review/approval capability, evidence, transition replay, stale-content denial, supersession, tenant/anon/direct-write/revocation denial',
  );
}
