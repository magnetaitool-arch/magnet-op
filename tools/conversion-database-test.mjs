import assert from 'node:assert/strict';

export async function verifyConversion({ client, orgA, orgB, user, role, asRole }) {
  const version = async () =>
    (await client.query("select version from crm_leads where legacy_record_id='workflow-lead'"))
      .rows[0].version;
  const convert = async (expected) =>
    (
      await client.query('select convert_crm_lead_v2($1,$2,$3) as result', [
        orgA,
        'workflow-lead',
        expected,
      ])
    ).rows[0].result;
  // Each scenario rolls back; no fixture IDs are mistaken for real business data.
  await asRole('authenticated', async () => {
    await client.query("select change_crm_lead_stage($1,'workflow-lead','Won')", [orgA]);
    const expected = await version();
    const first = await convert(expected);
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.workflow.stage, 2);
    assert.equal(first.client.monthlyRetainer, undefined);
    assert.equal(first.client.accountManagerId, undefined);
    const repeated = await convert(expected);
    assert.equal(repeated.replayed, true);
    assert.equal(repeated.client.id, first.client.id);
    assert.equal(repeated.workflow.id, first.workflow.id);
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='CRM_LEAD_CONVERTED'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from user_notifications_v2 where source_key='lead-converted:workflow-lead'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await client.query(
          'select count(*)::int n from client_accounts where legacy_record_id=$1',
          [first.client.id],
        )
      ).rows[0].n,
      1,
    );
  });
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query("select change_crm_lead_stage($1,'workflow-lead','Won')", [orgA]);
      await convert(0);
    }),
    { code: '40001' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query('select convert_crm_lead_v2($1,$2,1)', [orgB, 'workflow-lead']);
    }),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query('set local role postgres');
      await client.query(
        "delete from role_capabilities where role_id=$1 and capability_id in(select id from capabilities where key='clients.manage')",
        [role],
      );
      await client.query('set local role authenticated');
      await convert(1);
    }),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query('set local role postgres');
      await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
        user,
      ]);
      await client.query('set local role authenticated');
      await convert(1);
    }),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('anon', () => convert(1)),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () => convert(1)),
    { message: /lead_must_be_won/ },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query('set local role postgres');
      await client.query(
        'update records set data=data||\'{"email":"shared@example.invalid","status":"Won"}\' where id=\'workflow-lead\'',
      );
      await client.query(
        'update records set data=data||\'{"mainContactEmail":"shared@example.invalid"}\' where id=\'test-client-a\'',
      );
      await client.query('set local role authenticated');
      await convert(await version());
    }),
    { message: /client_contact_review_required/ },
  );
  await assert.rejects(
    asRole('authenticated', async () => {
      await client.query('set local role postgres');
      await client.query(
        'update records set data=data||\'{"convertedClientId":"test-client-b","status":"Won"}\' where id=\'workflow-lead\'',
      );
      await client.query('set local role authenticated');
      await convert(await version());
    }),
    { message: /client_link_review_required/ },
  );
  // Fail after the client insert, prove the transaction leaves no partial client.
  await client.query(`create function public.synthetic_conversion_failure() returns trigger language plpgsql as $$begin if new.coll='workflows' then raise exception 'synthetic_write_failure'; end if; return new; end;$$;
    create trigger synthetic_conversion_failure before insert on records for each row execute function synthetic_conversion_failure();`);
  const before = (await client.query('select count(*)::int n from client_accounts')).rows[0].n;
  try {
    await assert.rejects(
      asRole('authenticated', async () => {
        await client.query("select change_crm_lead_stage($1,'workflow-lead','Won')", [orgA]);
        await convert(await version());
      }),
      { message: /synthetic_write_failure/ },
    );
    assert.equal(
      (await client.query('select count(*)::int n from client_accounts')).rows[0].n,
      before,
    );
    assert.equal(
      (
        await client.query(
          "select data->>'convertedClientId' id from records where id='workflow-lead'",
        )
      ).rows[0].id,
      null,
    );
  } finally {
    await client.query(
      'drop trigger synthetic_conversion_failure on records; drop function synthetic_conversion_failure()',
    );
  }
  console.log(
    'PASS atomic lead conversion: persisted projections, replay, stale version, tenant/role/suspension/anon denial, ambiguity and mid-command rollback',
  );
}

export async function verifyConcurrentConversion({ client, orgA, user, connect }) {
  await client.query(
    'insert into records(id,coll,organization_id,data) values (\'concurrent-lead\',\'leads\',$1,\'{"name":"Concurrent synthetic lead","status":"Won"}\')',
    [orgA],
  );
  const connections = [connect(), connect()];
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
    const responses = await Promise.all(
      connections.map(async (c) => {
        const result = (
          await c.query("select convert_crm_lead_v2($1,'concurrent-lead',1) result", [orgA])
        ).rows[0].result;
        await c.query('commit');
        return result;
      }),
    );
    assert.equal(responses[0].client.id, responses[1].client.id);
    assert.equal(responses[0].workflow.id, responses[1].workflow.id);
    assert.deepEqual(responses.map((r) => r.replayed).sort(), [false, true]);
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='CRM_LEAD_CONVERTED' and entity_id='concurrent-lead'",
        )
      ).rows[0].n,
      1,
    );
    console.log(
      'PASS two concurrent committed conversion sessions produce one client/workflow/audit event',
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
}
