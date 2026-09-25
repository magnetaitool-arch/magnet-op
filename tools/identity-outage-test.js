'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync('supabase/functions/identity/index.ts','utf8'));
async function requestWith(fetch){
  let handler;const diagnostics=[];
  vm.runInNewContext(source,{Deno:{env:{get:()=> 'test'},serve:fn=>{handler=fn;}},fetch,Response,AbortSignal,crypto:{randomUUID:()=> 'test-request'},console:{error:line=>diagnostics.push(line)}});
  const response=await handler(new Request('https://identity.invalid',{method:'POST',headers:{authorization:'Bearer synthetic-token','content-type':'application/json'},body:'{"action":"context"}'}));
  return {response,diagnostics};
}
test('identity outage, rate limit and malformed Auth response remain recoverable and do not leak tokens',async()=>{
  for(const fetch of [async()=>{throw Error('offline');},async()=>new Response('{}',{status:503}),async()=>new Response('{}',{status:429}),async()=>new Response('{}')]){
    const {response,diagnostics}=await requestWith(fetch);assert.equal(response.status,503);
    assert.equal((await response.json()).error,'identity_unavailable');assert.ok(!diagnostics.join('').includes('synthetic-token'));
  }
});
test('identity returns unauthorized only when Auth explicitly rejects the session',async()=>{
  const {response}=await requestWith(async()=>new Response('{}',{status:401}));assert.equal(response.status,401);
});
test('identity context can return all active memberships without arbitrarily selecting one',async()=>{
  const user={id:'10000000-0000-4000-8000-000000000001'};
  const memberships=['a','b'].map(organizationId=>({organizationId,membershipStatus:'ACTIVE',organizationStatus:'ACTIVE'}));
  let calls=0;
  const {response}=await requestWith(async()=>new Response(JSON.stringify(++calls===1?user:{status:'ACTIVE',memberships})));
  assert.equal(response.status,200);assert.equal((await response.json()).context.memberships.length,2);
});
