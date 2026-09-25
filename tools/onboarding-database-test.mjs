import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyOnboarding({ client, orgA, orgB, user, asRole }) {
  const read = async (org = orgA) =>
    (await client.query("select get_client_onboarding_v2($1,'test-client-a') result", [org]))
      .rows[0].result;
  const save = async (version, index, done, key = randomUUID()) =>
    (
      await client.query(
        "select set_client_onboarding_item_v2($1,'test-client-a',$2,$3,$4,$5) result",
        [orgA, version, index, done, key],
      )
    ).rows[0].result;
  await asRole('authenticated', async () => {
    let state = await read();
    assert.equal(state.items.length, 5);
    assert.equal(
      state.items.every((x) => x.done === false),
      true,
    );
    const old = state.version,
      key = randomUUID();
    state = await save(old, 0, true, key);
    assert.equal(state.items[0].done, true);
    assert.equal((await save(old, 0, true, key)).replayed, true);
    await client.query('savepoint stale');
    await assert.rejects(save(old, 1, true), { code: '40001' });
    await client.query('rollback to savepoint stale');
    await client.query('savepoint conflicting');
    await assert.rejects(save(old, 0, false, key));
    await client.query('rollback to savepoint conflicting');
    for (let index = 1; index < 5; index++) state = await save(state.version, index, true);
    assert.equal(
      (await read()).items.every((x) => x.done),
      true,
    );
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='CLIENT_ONBOARDING_CHECKED' and entity_id='test-client-a'",
        )
      ).rows[0].n,
      5,
    );
    assert.equal(
      (await client.query("select data->'onboarding' items from records where id='test-client-a'"))
        .rows[0].items.length,
      5,
    );
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      user,
    ]);
    await client.query('set local role authenticated');
    await client.query('savepoint revoked');
    await assert.rejects(save(old, 0, true, key), { code: '42501' });
    await client.query('rollback to savepoint revoked');
  });
  await asRole('postgres', async () => {
    await client.query(
      'update records set data=data||\'{"onboarding":[{"item":"Custom legacy item","done":false,"reference":"keep-me"}]}\' where id=\'test-client-a\'',
    );
    await client.query('set local role authenticated');
    const current = await read();
    const saved = await save(current.version, 0, true);
    assert.equal(saved.items[0].reference, 'keep-me');
    assert.equal(saved.items[0].item, 'Custom legacy item');
  });
  for (const invalid of [{ item: 'not-an-array' }, [{ item: 'Ambiguous done', done: 'yes' }]])
    await asRole('postgres', async () => {
      await client.query(
        "update records set data=data||jsonb_build_object('onboarding',$1::jsonb) where id='test-client-a'",
        [JSON.stringify(invalid)],
      );
      await client.query('set local role authenticated');
      await client.query('savepoint malformed');
      await assert.rejects(read(), /onboarding_data_review_required/);
      await client.query('rollback to savepoint malformed');
      await client.query('set local role postgres');
      assert.deepEqual(
        (
          await client.query(
            "select data->'onboarding' items from records where id='test-client-a'",
          )
        ).rows[0].items,
        invalid,
      );
    });
  await assert.rejects(
    asRole('anon', () => read()),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () => read(orgB)),
    { code: '42501' },
  );
  console.log(
    'PASS onboarding checklist: persisted updates, immutable retry identity, stale conflict, fresh tenant authority, audit dedupe, legacy/custom field preservation, malformed data flagged without overwrite',
  );
}
