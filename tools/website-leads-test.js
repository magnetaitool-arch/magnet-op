'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {handlePublicIntake,_test:{sanitizePayload}}=require('../server/public-intake');
test('matcher schema preserves arrays and attribution; rejects malformed arrays and links',()=>{
 const x=sanitizePayload({type:'lead',name:' Test ',email:' USER@GMAIL.COM ',services:['Social','Social'],goals:['Growth'],language:'ar',form_source:'project_matcher',utm_campaign:'campaign',fbclid:'click',landing_page:'https://magnetofficial.com/'});
 assert.equal(x.email,'user@gmail.com');assert.deepEqual(x.services,['Social']);assert.equal(x.utm_campaign,'campaign');assert.equal(x.fbclid,'click');
 for(const bad of [{goals:'growth'},{services:[{}]},{website:'javascript:alert(1)'},{language:'anything'},{form_source:'careers'}])assert.throws(()=>sanitizePayload({type:'lead',name:'Test',phone:'201000000000',...bad}));
 const c=sanitizePayload({type:'candidate',fullName:'Candidate',mobile:'201000000000',email:'person@example.invalid',utm_source:'not-sales'});assert.equal(c.utm_source,undefined);
});
test('website transaction returns only after durable commit and never waits on email',async()=>{
 const original=global.fetch,calls=[];
 const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture',PUBLIC_INTAKE_SHARED_SECRET:'test-server-secret',SUPABASE_ORGANIZATION_SLUG:'phase4-test'};
 try{
 global.fetch=async(url,init)=>{calls.push(url);if(url.includes('/organizations?'))return Response.json([{id:'00000000-0000-4000-8000-000000000001'}]);if(url.endsWith('/rpc/submit_website_lead_v2')){const p=JSON.parse(init.body);assert.equal(p.p_payload.utm_source,'meta');assert.equal(p.p_intake_kind,undefined);return Response.json({ok:true,id:'synthetic-lead'});}throw Error('Unexpected nontransactional or provider call');};
 const request={method:'POST',headers:{'x-magnet-intake-secret':env.PUBLIC_INTAKE_SHARED_SECRET,'idempotency-key':'website:test-one'},websiteIntegration:true,body:{type:'lead',form_source:'contact',name:'Synthetic',email:'test@example.invalid',utm_source:'meta'}};
 const r=await handlePublicIntake(request,env);assert.equal(r.status,200);assert.equal(r.body.deliveryAttempted,0);assert.equal(calls.length,2);
 global.fetch=async()=>{throw Error('offline');};const denied=await handlePublicIntake({...request,headers:{}},env);assert.equal(denied.status,403);
 const failed=await handlePublicIntake(request,env);assert.equal(failed.status,503);assert.notEqual(failed.body.ok,true);
 }finally{global.fetch=original;}
});
