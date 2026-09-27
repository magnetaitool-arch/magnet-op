import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import M from '../magnet-studio/builder-model.js';
export async function verifyStudioBuilder({ client, orgA, orgB, user, asRole }) {
  const reject = async (fn, pattern) => {
    await client.query('savepoint builder_bad');
    await assert.rejects(fn(), pattern);
    await client.query('rollback to savepoint builder_bad');
  };
  await asRole('authenticated', async () => {
    const account = (
      await client.query("select id from client_accounts where legacy_record_id='test-client-a'")
    ).rows[0].id;
    const task = (
      await client.query(
        "select create_task_v2($1,'Builder fixture',$2,'workflow-project','workflow-employee') result",
        [orgA, account],
      )
    ).rows[0].result.task;
    const docId = randomUUID(),
      payload = M.create('proposal', { client: 'Canonical fixture' });
    const save = (p, rev = 0) =>
      client.query(
        "select studio_command_v2($1,$2,$3,'report',null,$4,'SAVE',$5,null,null,$6) result",
        [orgA, docId, task.id, rev, p, randomUUID()],
      );
    assert.equal((await save(payload)).rows[0].result.document.revision, 1);
    const bad = M.clone(payload);
    bad.pages[0].blocks[0].height = -1;
    await reject(() => save(bad, 1), /studio_builder_invalid/);
    const kit = { ...M.brand(), primary: '#123456' };
    const b = (
      await client.query('select studio_brand_v3($1,$2,0,$3) result', [orgA, task.id, kit])
    ).rows[0].result;
    assert.equal(b.kit.revision, 1);
    await reject(
      () => client.query('select studio_brand_v3($1,$2,0,$3)', [orgA, task.id, kit]),
      /studio_brand_conflict/,
    );
    assert.equal(
      (await client.query('select get_studio_v2($1,$2) result', [orgA, docId])).rows[0].result
        .versions[0].payload.brand.primary,
      '#11140e',
    );
    await client.query('select studio_template_v3($1,$2,$3,$4)', [
      orgA,
      task.id,
      'Reusable proposal',
      payload,
    ]);
    const resources = (
      await client.query('select studio_resources_v3($1,$2) result', [orgA, task.id])
    ).rows[0].result;
    assert.equal(resources.templates.length, 1);
    await reject(() => client.query('select studio_resources_v3($1,$2)', [orgB, task.id]), {
      code: '42501',
    });
    const shared = (
      await client.query("select studio_share_v3($1,$2,'CREATE',null,true,7) result", [orgA, docId])
    ).rows[0].result;
    assert.match(shared.token, /^[a-f0-9]{64}$/);
    await client.query('set local role anon');
    await client.query("select set_config('request.jwt.claim.sub','',true)");
    await reject(() => client.query('select * from studio_shares_v3'), { code: '42501' });
    let view = (await client.query('select studio_shared_v3($1) result', [shared.token])).rows[0]
      .result;
    assert.equal(view.payload.title, payload.title);
    assert.equal(view.payload.binding, undefined);
    assert.equal(view.organization_id, undefined);
    await client.query(
      "select studio_shared_v3($1,'COMMENT','Specific page feedback','External reviewer',$2,$3)",
      [shared.token, payload.pages[0].id, payload.pages[0].blocks[0].id],
    );
    await reject(
      () =>
        client.query("select studio_shared_v3($1,'COMMENT','Bad target','Reviewer','not-a-page')", [
          shared.token,
        ]),
      /review_target_invalid/,
    );
    await reject(() => client.query('select studio_shared_v3($1)', ['0'.repeat(64)]), {
      code: '42501',
    });
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    const comments = (await client.query('select studio_comments_v3($1,$2) result', [orgA, docId]))
      .rows[0].result.comments;
    assert.equal(comments[0].external, true);
    assert.equal(comments[0].pageId, payload.pages[0].id);
    await client.query("select studio_share_v3($1,$2,'REVOKE',$3)", [orgA, docId, shared.id]);
    await reject(() => client.query('select studio_shared_v3($1)', [shared.token]), {
      code: '42501',
    });
    const readonly = (
      await client.query("select studio_share_v3($1,$2,'CREATE',null,false,1) result", [
        orgA,
        docId,
      ])
    ).rows[0].result;
    await reject(
      () =>
        client.query("select studio_shared_v3($1,'APPROVE','Yes','Reviewer')", [readonly.token]),
      { code: '42501' },
    );
  });
  console.log(
    'PASS builder structured validation, optimistic brand updates, immutable style snapshot, reusable templates, scoped public share/review/revocation and tenant isolation',
  );
}
