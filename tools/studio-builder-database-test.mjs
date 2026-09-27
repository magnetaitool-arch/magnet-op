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
    const contentId = randomUUID();
    await client.query('set local role postgres');
    await client.query(
      "insert into studio_documents_v2(id,organization_id,task_id,kind,revision,status,created_by) values($1,$2,$3,'content',1,'DRAFT',$4)",
      [contentId, orgA, task.id, user],
    );
    await client.query(
      'insert into studio_versions_v2(organization_id,document_id,revision,payload,created_by) values($1,$2,1,$3,$4)',
      [
        orgA,
        contentId,
        { title: 'Approved source fixture', body: 'Actual approved content' },
        user,
      ],
    );
    await client.query('set local role authenticated');
    const sources = async () =>
      (await client.query('select studio_resources_v3($1,$2) result', [orgA, task.id])).rows[0]
        .result.sources;
    assert.ok(
      !(await sources()).some((x) => x.id === contentId),
      'Draft content must not be exposed as approved',
    );
    await client.query('set local role postgres');
    await client.query("update studio_documents_v2 set status='APPROVED' where id=$1", [contentId]);
    await client.query('set local role authenticated');
    const source = (await sources()).find((x) => x.id === contentId);
    assert.equal(source.type, 'studio_content');
    assert.equal(source.summary, 'Actual approved content');
    assert.equal(source.revision, 1);

    await reject(() => client.query('select studio_resources_v3($1,$2)', [orgB, task.id]), {
      code: '42501',
    });
    const sibling = (
      await client.query(
        "select create_task_v2($1,'Sibling logo task',$2,'workflow-project','workflow-employee') result",
        [orgA, account],
      )
    ).rows[0].result.task;
    const image = (
      await client.query(
        "select create_document_upload_v2($1,'Client logo','Company Document','INTERNAL','logo.png','image/png',12) result",
        [orgA],
      )
    ).rows[0].result;
    await client.query(
      "insert into storage.objects(bucket_id,name) values ('magnet-documents',$1)",
      [image.originalPath],
    );
    await client.query('select finalize_document_upload_v2($1,$2)', [orgA, image.id]);
    payload.brand.logoId = image.id;
    payload.pages[0].blocks[0].mediaId = image.id;
    await save(payload, 1);
    await reject(
      () => client.query("select studio_share_v3($1,$2,'CREATE')", [orgA, docId]),
      /studio_shared_image_invalid/,
    );
    await client.query('select link_task_document_v2($1,$2,$3)', [orgA, sibling.id, image.id]);
    const shared = (
      await client.query("select studio_share_v3($1,$2,'CREATE',null,true,7) result", [orgA, docId])
    ).rows[0].result;
    assert.match(shared.token, /^[a-f0-9]{64}$/);
    await client.query('set local role service_role');
    const signedAsset = (
      await client.query('select studio_shared_asset_v3($1,$2) result', [shared.token, image.id])
    ).rows[0].result;
    assert.equal(signedAsset.path, image.originalPath);
    assert.ok(signedAsset.expiresIn <= 60);
    await reject(
      () => client.query('select studio_shared_asset_v3($1,$2)', [shared.token, randomUUID()]),
      { code: '42501' },
    );

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
    await client.query('set local role postgres');
    await client.query(
      "update organization_members set status='SUSPENDED' where organization_id=$1 and user_id=$2",
      [orgA, user],
    );
    await client.query('set local role anon');
    await reject(() => client.query('select studio_shared_v3($1)', [readonly.token]), {
      code: '42501',
    });
    await client.query('set local role postgres');
    await client.query(
      "update organization_members set status='ACTIVE' where organization_id=$1 and user_id=$2",
      [orgA, user],
    );
    await client.query(
      "update studio_shares_v3 set expires_at=now()-interval '1 second' where id=$1",
      [readonly.id],
    );
    await client.query('set local role anon');
    await reject(() => client.query('select studio_shared_v3($1)', [readonly.token]), {
      code: '42501',
    });
  });
  console.log(
    'PASS builder structured validation, optimistic brand updates, immutable style snapshot, reusable templates, scoped public share/review/revocation and tenant isolation',
  );
}
