'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { verifySignature, handleWebhook } = require('../server/resend-webhook');
const { renderEmail, TITLES } = require('../server/email-templates');
const { _test: { deliverEmail } } = require('../server/outbox');
test('Svix official signature vector verifies original bytes only', () => {
 const body=Buffer.from('{"event_type":"ping","data":{"success":true}}');
 const headers={'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='};
 const secret='whsec_plJ3nmyCDGBKInavdOK15jsl';
 assert.equal(verifySignature(body,headers,secret,1731705121000),true);
 assert.equal(verifySignature(Buffer.concat([body,Buffer.from(' ')]),headers,secret,1731705121000),false);
 assert.equal(verifySignature(body,headers,secret,1731705521000),false);
 assert.equal(verifySignature(body,headers,'',1731705121000),false);
});
test('templates escape untrusted HTML and forbid off-site CTA',()=>{
 for(const eventType of Object.keys(TITLES)){
  const mail=renderEmail({eventType,message:'<script>alert(1)</script>',route:'//evil.example'});
  assert.ok(mail.html.includes('&lt;script&gt;'));assert.ok(!mail.html.includes('evil.example'));
  assert.ok(mail.text.includes('https://magnet-op.vercel.app'));assert.ok(mail.html.includes('MADE TO MATTER.'));
 }
});
test('delivery distinguishes acceptance from delivery; rejects unsafe retries and missing config',async()=>{
 const original=global.fetch;let calls=0;
 const message={kind:'EMAIL_NOTIFICATION',attempt_count:1,idempotency_key:'notification:test',payload:{to:['person@gmail.com'],title:'Test'}};
 const env={RESEND_API_KEY:'fixture',EMAIL_FROM:'Magnet <test@example.invalid>',EMAIL_REPLY_TO:'reply@example.invalid'};
 try{
 global.fetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body);assert.equal(body.reply_to,env.EMAIL_REPLY_TO);assert.equal(init.headers['Idempotency-Key'],message.idempotency_key);return Response.json({id:'provider-id'});};
 assert.equal((await deliverEmail(message,env)).outcome,'ACCEPTED');
 assert.equal((await deliverEmail(message,{})).errorCategory,'CONFIGURATION_MISSING');
 assert.equal((await deliverEmail({...message,attempt_count:2,created_at:'2020-01-01'},env)).errorCategory,'IDEMPOTENCY_WINDOW_EXPIRED');
 assert.equal(calls,1);
 global.fetch=async()=>Response.json({}, {status:422});assert.equal((await deliverEmail(message,env)).errorCategory,'PROVIDER_PERMANENT');
 global.fetch=async()=>Response.json({}, {status:429});assert.equal((await deliverEmail(message,env)).errorCategory,'PROVIDER_TEMPORARY');
 }finally{global.fetch=original;}
});
test('webhook authenticates before persistence and retries failed storage',async()=>{
 const original=global.fetch;let calls=0;
 const secret='whsec_'+Buffer.from('test-secret-not-live').toString('base64');
 const body=Buffer.from(JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:'00000000-0000-4000-8000-000000000001'}}));
 const h={'svix-id':'event-test','svix-timestamp':String(Math.floor(Date.now()/1000))};
 h['svix-signature']='v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(h['svix-id']+'.'+h['svix-timestamp']+'.').update(body).digest('base64');
 const env={RESEND_WEBHOOK_SECRET:secret,SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'};
 try{global.fetch=async()=>{calls++;return Response.json({}, {status:503});};
 assert.equal((await handleWebhook(body,{...h,'svix-signature':'invalid'},env)).status,401);assert.equal(calls,0);
 assert.equal((await handleWebhook(body,h,env)).status,503);assert.equal(calls,1);
 }finally{global.fetch=original;}
});
