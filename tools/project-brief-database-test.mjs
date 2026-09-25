import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyProjectBriefs({ client, orgA, orgB, user, asRole, connect }) {
  const source = {
    clientId: 'test-client-a',
    company: 'Synthetic studio',
    status: 'submitted',
    submittedAt: '2026-09-26T10:00:00Z',
    token: 'not-for-execution',
    internalNotes: 'private note',
    answers: {
      objective: 'Launch the brand',
      audience: 'Local founders',
      contactName: 'Private contact',
      whatsapp: 'private-phone',
      consent: true,
    },
  };
  await client.query(
    "insert into records(id,coll,organization_id,data) values('workflow-brief','briefs',$1,$2)",
    [orgA, JSON.stringify(source)],
  );
  const get = async (org = orgA) =>
    (await client.query("select get_project_briefs_v2($1,'workflow-project') result", [org]))
      .rows[0].result;
  const capture = async (hash, revision = 0, command = randomUUID(), brief = 'workflow-brief') =>
    (
      await client.query(
        "select capture_project_brief_v2($1,'workflow-project',$2,$3,$4,$5) result",
        [orgA, brief, hash, revision, command],
      )
    ).rows[0].result;
  const reject = async (fn, pattern) => {
    await client.query('savepoint negative');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint negative');
  };
  await asRole('authenticated', async () => {
    const initial = await get();
    assert.equal(initial.revision, 0);
    assert.equal(initial.sources.length, 1);
    const hash = initial.sources[0].sourceHash,
      key = randomUUID();
    const out = await capture(hash, 0, key);
    assert.equal(out.revision, 1);
    assert.equal(out.revisions[0].capturedBy, user);
    assert.equal(out.revisions[0].snapshot.answers.objective, source.answers.objective);
    assert.equal(out.revisions[0].sourceChanged, false);
    assert.equal(JSON.stringify(out).includes('private-phone'), false);
    assert.equal(JSON.stringify(out).includes('private note'), false);
    assert.equal(JSON.stringify(out).includes('not-for-execution'), false);
    assert.equal((await capture(hash, 0, key)).replayed, true);
    await reject(() => capture(hash, 1, key), /idempotency_conflict/);
    await reject(() => capture(hash, 0), /project_brief_version_conflict/);
    await reject(() => capture(hash, 1), /project_brief_already_current/);
    await reject(
      () =>
        client.query(
          "update records set data=jsonb_set(data,'{clientId}','\"test-client-b\"') where id='workflow-project'",
        ),
      /project_brief_relationship_locked/,
    );
    await client.query('set local role postgres');
    await reject(
      () => client.query('update project_brief_revisions_v2 set revision=10'),
      /project_brief_history_immutable/,
    );
    await reject(() => client.query("delete from records where id='workflow-brief'"), {
      code: '23503',
    });
    await client.query(
      "update records set data=jsonb_set(data,'{answers,objective}','\"Revised launch goals\"') where id='workflow-brief'",
    );
    await client.query('set local role authenticated');
    const changed = await get();
    assert.equal(changed.revisions[0].sourceChanged, true);
    assert.equal(changed.revisions[0].snapshot.answers.objective, 'Launch the brand');
    await reject(() => capture(hash, 1), /project_brief_source_changed/);
    const newer = await capture(changed.sources[0].sourceHash, 1);
    assert.equal(newer.revision, 2);
    assert.equal(newer.revisions[0].snapshot.answers.objective, 'Revised launch goals');
    assert.equal((await capture(hash, 0, key)).revision, 2); // replay returns fresh state
    await client.query('set local role postgres');
    assert.equal(
      (
        await client.query(
          "select count(*)::int n from audit_events where action='PROJECT_BRIEF_CAPTURED'",
        )
      ).rows[0].n,
      2,
    );
    await client.query("update organization_members set status='SUSPENDED' where user_id=$1", [
      user,
    ]);
    await client.query('set local role authenticated');
    await reject(() => capture(hash, 0, key), { code: '42501' });
  });
  await assert.rejects(
    asRole('anon', () => get()),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () => get(orgB)),
    { code: '42501' },
  );
  await assert.rejects(
    asRole('authenticated', () => client.query('select * from project_brief_revisions_v2')),
    { code: '42501' },
  );
  await asRole('authenticated', async () => {
    const hash = (await get()).sources[0].sourceHash;
    await client.query('set local role postgres');
    await client.query(
      "update records set data=jsonb_set(data,'{clientId}','\"test-client-b\"') where id='workflow-brief'",
    );
    await client.query('set local role authenticated');
    assert.equal((await get()).sources.length, 0);
    await reject(() => capture(hash), /project_brief_client_mismatch/);
  });
  const connections = [connect(), connect()],
    command = randomUUID();
  const hash = (
    await client.query(
      "select encode(extensions.digest(brief_execution_snapshot_v2(data)::text,'sha256'),'hex') hash from records where id='workflow-brief'",
    )
  ).rows[0].hash;
  try {
    const results = await Promise.all(
      connections.map(async (connection) => {
        await connection.connect();
        await connection.query('begin');
        await connection.query('set local role authenticated');
        await connection.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
        const out = (
          await connection.query(
            "select capture_project_brief_v2($1,'workflow-project','workflow-brief',$2,0,$3) result",
            [orgA, hash, command],
          )
        ).rows[0].result;
        await connection.query('commit');
        return out;
      }),
    );
    assert.equal(results[0].revisions[0].id, results[1].revisions[0].id);
    assert.equal(results.filter((x) => x.replayed).length, 1);
  } finally {
    await Promise.all(connections.map((connection) => connection.end()));
  }
  console.log(
    'PASS project brief snapshots: tenant/client linkage, private-field exclusion, immutable history, source/version conflicts, fresh replay and revoked access',
  );
}
