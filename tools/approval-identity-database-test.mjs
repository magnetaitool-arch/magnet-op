import assert from 'node:assert/strict';
export async function verifyApprovalIdentity({ client, orgA, user, role, asRole }) {
  const other = '00000000-0000-4000-8000-000000000002';
  const resolve = async (subject) =>
    (await client.query('select approval_user_for_legacy_subject_v2($1) id', [subject])).rows[0].id;
  await asRole('postgres', async () => {
    assert.equal(await resolve(null), null);
    assert.equal(await resolve(''), null);
    assert.equal(await resolve('unknown'), null);
    assert.equal(await resolve(user), user);
    await client.query("update profiles set employee_id='approval-subject' where id=$1", [other]);
    assert.equal(await resolve('approval-subject'), other);
    await client.query(
      "insert into legacy_identity_links(legacy_account_row_id,auth_user_id,employee_record_id,link_status) values ('approval-link',$1,'approval-subject','CONFIRMED')",
      [other],
    );
    assert.equal(
      await resolve('approval-subject'),
      other,
      'same identity through multiple paths is unambiguous',
    );
    await client.query("update profiles set employee_id='approval-subject' where id=$1", [user]);
    assert.equal(await resolve('approval-subject'), null);
    await client.query('update profiles set employee_id=$1 where id=$2', [user, other]);
    assert.equal(
      await resolve(user),
      null,
      'UUID-looking subject must not override conflicting employee mapping',
    );
    await client.query('update profiles set employee_id=null where id=$1', [other]);
    await client.query(
      "update legacy_identity_links set legacy_account_row_id=$1 where legacy_account_row_id='approval-link'",
      [user],
    );
    assert.equal(await resolve(user), null, 'confirmed legacy account collision must fail closed');
  });
  for (const state of [
    'ACTIVE',
    'MISSING_MEMBER',
    'SUSPENDED_MEMBER',
    'SUSPENDED_PROFILE',
    'AMBIGUOUS',
  ]) {
    await asRole('postgres', async () => {
      await client.query(
        "insert into role_capabilities(role_id,capability_id) select $1,id from capabilities where key='approvals.manage' on conflict do nothing",
        [role],
      );
      if (state !== 'MISSING_MEMBER')
        await client.query(
          'insert into organization_members(organization_id,user_id,role_id,joined_at,status) values ($1,$2,$3,now(),$4)',
          [orgA, other, role, state === 'SUSPENDED_MEMBER' ? 'SUSPENDED' : 'ACTIVE'],
        );
      await client.query('update profiles set employee_id=$1,identity_status=$2 where id=$3', [
        'approval-recipient',
        state === 'SUSPENDED_PROFILE' ? 'SUSPENDED' : 'ACTIVE',
        other,
      ]);
      if (state === 'AMBIGUOUS')
        await client.query("update profiles set employee_id='approval-recipient' where id=$1", [
          user,
        ]);
      await client.query(
        'insert into records(id,coll,organization_id,data) values (\'approval-identity-check\',\'approvalRequests\',$1,\'{"status":"Pending Approval","title":"Synthetic request","requestedBy":"approval-recipient"}\')',
        [orgA],
      );
      await client.query('set local role authenticated');
      const out = (
        await client.query(
          "select transition_approval_v2($1,'approvalRequests','approval-identity-check','Pending Approval','APPROVE','Synthetic decision') result",
          [orgA],
        )
      ).rows[0].result;
      assert.equal(
        out.ok,
        true,
        'valid decision remains saved when recipient cannot be resolved safely',
      );
      await client.query('set local role postgres');
      const rows = (
        await client.query(
          "select recipient_user_id from user_notifications_v2 where entity_id='approval-identity-check'",
        )
      ).rows;
      assert.equal(rows.length, state === 'ACTIVE' ? 1 : 0, state);
      if (rows.length) assert.equal(rows[0].recipient_user_id, other);
    });
  }
  for (const roleName of ['anon', 'authenticated'])
    await assert.rejects(
      asRole(roleName, () => resolve(user)),
      { code: '42501' },
    );
  console.log(
    'PASS approval notifications: ambiguous identity fails closed, consistent aliases dedupe, active tenant recipient required, decisions remain atomic, helper private',
  );
}
