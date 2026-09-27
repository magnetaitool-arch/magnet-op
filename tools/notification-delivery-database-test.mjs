import assert from 'node:assert/strict';
export async function verifyNotificationDelivery({client,orgA,orgB,user,asRole}) {
 await asRole('authenticated',async()=>{
  let r=(await client.query('select notification_preferences_v2($1) value',[orgA])).rows[0].value;
  assert.equal(r.assignments,true);
  r=(await client.query("select notification_preferences_v2($1,'assignments',false) value",[orgA])).rows[0].value;
  assert.equal(r.assignments,false);
  await client.query('set local role postgres');
  const insert=async key=>(await client.query(`insert into user_notifications_v2(organization_id,recipient_user_id,notification_type,title,source_key) values($1,$2,'TASK_ASSIGNED','Synthetic assignment',$3) returning id`,[orgA,user,key])).rows[0].id;
  const first=await insert('email-optout');
  assert.equal((await client.query("select count(*)::int n from outbox_messages where idempotency_key=$1",['notification:'+first])).rows[0].n,0);
  await client.query('set local role authenticated');
  await client.query("select notification_preferences_v2($1,'assignments',true)",[orgA]);
  await client.query('set local role postgres');
  const second=await insert('email-optin');
  const m=(await client.query("select * from outbox_messages where idempotency_key=$1",['notification:'+second])).rows[0];
  assert.equal(m.kind,'EMAIL_NOTIFICATION');assert.equal(m.payload.recipientUserId,user);
  // Provider callback arriving before finish must reconcile, replay once, and never regress.
  const provider='00000000-0000-4000-8000-000000000099';
  await client.query("select apply_resend_event_v2('receipt-test',$1,'email.delivered','2026-09-27T10:00:00Z')",[provider]);
  await client.query("update outbox_messages set status='ACCEPTED',provider_message_id=$2 where id=$1",[m.id,provider]);
  await client.query("select apply_resend_event_v2('receipt-test',$1,'email.delivered','2026-09-27T10:00:00Z')",[provider]);
  await client.query("select apply_resend_event_v2('receipt-old',$1,'email.sent','2026-09-27T09:00:00Z')",[provider]);
  assert.equal((await client.query('select status from outbox_messages where id=$1',[m.id])).rows[0].status,'DELIVERED');
  assert.equal((await client.query("select count(*)::int n from email_provider_events_v2 where event_id='receipt-test'")).rows[0].n,1);
 });
 await assert.rejects(asRole('authenticated',()=>client.query('select notification_preferences_v2($1)',[orgB])),{code:'42501'});
 await assert.rejects(asRole('authenticated',()=>client.query("select notification_preferences_v2($1,'security',false)",[orgA])),{code:'22023'});
 await assert.rejects(asRole('anon',()=>client.query('select notification_preferences_v2($1)',[orgA])),{code:'42501'});
 await assert.rejects(asRole('authenticated',()=>client.query("select apply_resend_event_v2('forged','fake','email.delivered',now())")),{code:'42501'});
 console.log('PASS notification preferences, tenant isolation, event outbox, webhook replay/order/race');
}
