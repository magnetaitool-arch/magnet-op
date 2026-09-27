import assert from 'node:assert/strict';
export async function verifyWebsiteAcquisition({client,orgA,orgB,user,asRole}){
 await asRole('authenticated',async()=>{
  await client.query("select website_lead_rules_v2($1,true,$2,24,'Qualified')",[orgA,user]);
  await client.query('set local role service_role');
  const payload={name:'Synthetic Phase4 Lead',company:'Synthetic Phase4',email:'phase4@example.invalid',phone:'201000000099',form_source:'project_matcher',language:'ar',utm_source:'meta',utm_campaign:'synthetic',goals:['Growth'],services:['Social']};
  const submit=async(key,hash='a'.repeat(64),data=payload)=>(await client.query('select submit_website_lead_v2($1,$2,$3,$4,$5) result',[orgA,JSON.stringify(data),key,hash,'f'.repeat(64)])).rows[0].result;
  const first=await submit('website-e2e-one');assert.equal(first.ok,true);
  assert.equal((await submit('website-e2e-one')).id,first.id);
  assert.equal((await submit('website-e2e-two')).id,first.id);
  const ambiguous=await submit('website-e2e-three','b'.repeat(64),{...payload,company:'Different company'});
  assert.notEqual(ambiguous.id,first.id);assert.equal(ambiguous.reviewRequired,true);
  await client.query('set local role postgres');
  const row=(await client.query('select * from crm_leads where id=$1',[first.crmLeadId])).rows[0];
  await client.query("insert into records(id,coll,organization_id,data) values('phase4-proposal','proposals',$1,jsonb_build_object('title','Synthetic attribution','leadId',$2::text))",[orgA,first.id]);
  assert.equal((await client.query("select data->'acquisitionAttribution'->>'utm_campaign' campaign from records where id='phase4-proposal'")).rows[0].campaign,'synthetic');
  await client.query('set local role authenticated');
  const metrics=(await client.query('select acquisition_metrics_v2($1) result',[orgA])).rows[0].result;
  assert.equal(metrics.websiteLeads,2);assert.ok(metrics.sources.some(s=>s.source==='meta'));
  await client.query('set local role postgres');
  assert.equal(row.payload.utm_campaign,'synthetic');assert.equal(row.payload.language,'ar');assert.equal(row.payload.assignedAuthUserId,user);
  assert.equal((await client.query('select count(*)::int n from crm_followups_v2 where lead_id=$1',[first.crmLeadId])).rows[0].n,1);
  assert.equal((await client.query("select count(*)::int n from user_notifications_v2 where entity_id=$1 and notification_type='LEAD_ASSIGNED'",[first.id])).rows[0].n,1);
  assert.equal((await client.query('select count(*)::int n from user_notifications_v2 where entity_id=$1 and recipient_user_id=$2',[first.id,user])).rows[0].n,1);
  assert.equal((await client.query("select count(*)::int n from outbox_messages where kind='EMAIL_NOTIFICATION' and payload->>'entityId'=$1",[first.id])).rows[0].n,1);
 });
 await assert.rejects(asRole('authenticated',()=>client.query('select website_lead_rules_v2($1)',[orgB])),{code:'42501'});
 await assert.rejects(asRole('authenticated',()=>client.query("select submit_website_lead_v2($1,'{}','forged-key','hash','fingerprint')",[orgA])),{code:'42501'});
 console.log('PASS website lead replay, exact-content dedup, ambiguity preservation, attribution, assignment, follow-up, alert/email queue and tenant denial');
}
