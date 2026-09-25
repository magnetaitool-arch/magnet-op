import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyPublicProposal({ client, orgA, orgB, role, asRole }) {
  const read = async (token) =>
    (await client.query('select get_public_proposal_v2($1) result', [token])).rows[0].result;
  const accept = async (token, hash) =>
    (
      await client.query(
        "select accept_public_proposal_v2($1,$2,'Synthetic recipient','client@example.invalid',true) result",
        [token, hash],
      )
    ).rows[0].result;
  const setup = async () => {
    await client.query('set local role postgres');
    await client.query(
      "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='approvals.manage' on conflict do nothing",
      [role],
    );
    await client.query(
      'update records set data=data||\'{"internalNotes":"PRIVATE_DO_NOT_EXPOSE"}\' where id=\'workflow-proposal\'',
    );
    await client.query('set local role authenticated');
    const current = (
      await client.query("select get_proposal_revisions_v2($1,'workflow-proposal') result", [orgA])
    ).rows[0].result;
    let view = (
      await client.query(
        "select create_proposal_revision_v2($1,'workflow-proposal',$2,$3) result",
        [orgA, current.currentHash, randomUUID()],
      )
    ).rows[0].result;
    for (const action of ['REVIEW', 'APPROVE'])
      view = (
        await client.query('select transition_proposal_revision_v2($1,$2,$3,$4,null,$5) result', [
          orgA,
          view.revisions[0].id,
          view.revisions[0].version,
          action,
          randomUUID(),
        ])
      ).rows[0].result;
    const revision = view.revisions[0];
    const link = (
      await client.query("select manage_proposal_review_link_v2($1,$2,'CREATE') result", [
        orgA,
        revision.id,
      ])
    ).rows[0].result;
    return { link, revision };
  };
  await asRole('authenticated', async () => {
    const { link, revision } = await setup();
    assert.match(link.token, /^[a-f0-9]{64}$/);
    await client.query('set local role anon');
    const page = await read(link.token);
    assert.equal(page.ok, true);
    assert.equal(page.proposal.title, 'Synthetic scope');
    assert.ok(!JSON.stringify(page).includes('PRIVATE_DO_NOT_EXPOSE'));
    assert.equal(page.proposal.clientId, undefined);
    assert.equal(page.organizationId, undefined);
    assert.equal((await accept(link.token, '0'.repeat(64))).ok, false);
    for (const [name, email, confirm] of [
      ['Synthetic client', 'client@example.invalid', false],
      ['', 'client@example.invalid', true],
      ['Synthetic client', 'invalid', true],
    ]) {
      const invalid = (
        await client.query('select accept_public_proposal_v2($1,$2,$3,$4,$5) result', [
          link.token,
          revision.content_hash,
          name,
          email,
          confirm,
        ])
      ).rows[0].result;
      assert.equal(invalid.ok, false);
      assert.equal((await read(link.token)).state, 'APPROVED');
    }

    assert.equal((await accept(link.token, revision.content_hash)).ok, true);
    assert.equal((await accept(link.token, revision.content_hash)).alreadyAccepted, true);
    const after = await read(link.token);
    assert.equal(after.state, 'ACCEPTED');
    assert.ok(after.acceptedAt);
    assert.equal(after.respondent_email, undefined);
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='PROPOSAL_CLIENT_LINK_ACCEPTED'",
        )
      ).rows[0].n,
      1,
    );
    const stored = (
      await client.query('select * from proposal_review_links_v2 where id=$1', [link.id])
    ).rows[0];
    assert.equal(stored.respondent_email, 'client@example.invalid');
    assert.notEqual(stored.token_hash, link.token);
    assert.ok(!Object.values(stored).includes(link.token));
  });
  for (const invalidation of ['REVOKE', 'EXPIRE', 'EDIT', 'SUSPEND_ORG']) {
    await asRole('authenticated', async () => {
      const { link, revision } = await setup();
      if (invalidation === 'REVOKE')
        await client.query("select manage_proposal_review_link_v2($1,$2,'REVOKE',$3)", [
          orgA,
          revision.id,
          link.id,
        ]);
      else {
        await client.query('set local role postgres');
        if (invalidation === 'EXPIRE')
          await client.query(
            "update proposal_review_links_v2 set expires_at=now()-interval '1 second' where id=$1",
            [link.id],
          );
        if (invalidation === 'EDIT') {
          await client.query("select set_config('app.proposal_revision_command','',true)");
          await client.query(
            "update records set data=data||'{\"price\":90000}' where id='workflow-proposal'",
          );
        }
        if (invalidation === 'SUSPEND_ORG')
          await client.query("update organizations set status='SUSPENDED' where id=$1", [orgA]);
      }
      await client.query('set local role anon');
      assert.equal((await read(link.token)).ok, false);
      assert.equal((await accept(link.token, revision.content_hash)).ok, false);
    });
  }
  await asRole('anon', async () => {
    assert.equal((await read('bad')).ok, false);
    assert.equal((await read('0'.repeat(64))).ok, false);
  });
  await assert.rejects(
    asRole('anon', () => client.query('select * from proposal_review_links_v2')),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () =>
      client.query("select manage_proposal_review_link_v2($1,$2,'CREATE')", [orgB, randomUUID()]),
    ),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () =>
      client.query("select manage_proposal_review_link_v2($1,$2,'CREATE')", [orgA, randomUUID()]),
    ),
    { code: '42501' },
  );
  console.log(
    'PASS public proposal: approved exact snapshot, public-field allowlist, hash-only capability, explicit acceptance/replay, expiration/revocation/content-change/organization denial, private-table and cross-tenant denial',
  );
}
