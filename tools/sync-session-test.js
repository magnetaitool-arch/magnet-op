'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
function fixture(){
 let actor={authUserId:'owner',organizationId:'workspace'},token='expired',queue=[],writes=0,refresh=()=>{token='fresh';},identity=()=>({ok:true,user:actor}),response=200;
 const c={AUTH_V2:{enabled:true},Map,Date,Number,String,Array,Object,window:{},getCfg:()=>({url:'test'}),cfgComplete:()=>true,getSessionUser:()=>actor,activeOrganizationId:()=>actor?.organizationId,
 syncQueueLoad:()=>structuredClone(queue),syncQueueSave:x=>{queue=x;},syncQueueChip:()=>{},moSaveStatus:()=>{},loadAuthV2Flag:async()=>{},sbEnsureFresh:async()=>refresh(),sbAccessToken:()=>token,
 loadCanonicalIdentity:async()=>identity(),cloudRecordWithAuthorship:(_,r)=>r,_rest:(_,p)=>p,_headers:()=>({Authorization:token}),tenantRecord:r=>({...r,organization_id:actor.organizationId}),tenantOrganizationId:()=>actor.organizationId,
 fetch:async()=>{writes++;return {ok:response===200,status:response};},syncFailureFromResponse:async r=>({status:r.status,category:r.status===401?'auth':'permission',retryable:false}),syncNetworkFailure:()=>({retryable:true}),syncFailure:()=>({retryable:true}),syncRetryDelay:()=>5000,syncWarn:()=>{}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('function syncQueueScope(){'),html.indexOf('function syncQueueSave('))+html.slice(html.indexOf('function syncQueueItemKey('),html.indexOf('function syncQueuePush('))+html.slice(html.indexOf('let _sqDraining=false;'),html.indexOf('function syncQueueDiagnostics(){')),c);
 const item=(category='auth')=>({...actor,type:'upsert',coll:'gameScores',rec:{id:'arc-usr-owner'},blocked:true,lastFailure:{category,status:category==='auth'?401:403}});
 return {c,item,setQueue:x=>{queue=x;},queue:()=>queue,writes:()=>writes,setActor:x=>{actor=x;},setToken:x=>{token=x;},setRefresh:f=>{refresh=f;},setIdentity:f=>{identity=f;},setResponse:x=>{response=x;}};
}
test('SIGN IN queue resumes after shared-session restoration without separate Studio login',async()=>{const f=fixture();f.setQueue([f.item()]);await f.c.syncQueueDrain();assert.equal(f.writes(),1);assert.equal(f.queue().length,0);});
test('no JWT sends no write and preserves pending data',async()=>{const f=fixture();f.setQueue([f.item()]);f.setRefresh(()=>f.setToken(''));await f.c.syncQueueDrain({manual:true});assert.equal(f.writes(),0);assert.equal(f.queue().length,1);});
test('permission failures are not silently retried',async()=>{const f=fixture();f.setQueue([f.item('permission')]);await f.c.syncQueueDrain();assert.equal(f.writes(),0);});
test('logout or workspace switch during refresh cannot replay queued work',async()=>{for(const actor of [null,{authUserId:'other',organizationId:'workspace'},{authUserId:'owner',organizationId:'other'}]){const f=fixture();f.setQueue([f.item()]);f.setRefresh(()=>f.setActor(actor));await f.c.syncQueueDrain();assert.equal(f.writes(),0);assert.equal(f.queue().length,1);}});
test('server identity must match queued owner and workspace',async()=>{const f=fixture();f.setQueue([f.item()]);f.setIdentity(()=>({ok:true,user:{authUserId:'other',organizationId:'workspace'}}));await f.c.syncQueueDrain();assert.equal(f.writes(),0);});
test('401 is not hammered with the same token, but a new login can resume',async()=>{const f=fixture();f.setQueue([f.item()]);f.setResponse(401);await f.c.syncQueueDrain();await f.c.syncQueueDrain();assert.equal(f.writes(),1);f.setRefresh(()=>f.setToken('new-login'));f.setResponse(200);await f.c.syncQueueDrain();assert.equal(f.writes(),2);assert.equal(f.queue().length,0);});
test('session changes during identity lookup prevent sending',async()=>{const f=fixture();f.setQueue([f.item()]);f.setIdentity(()=>{const user={authUserId:'owner',organizationId:'workspace'};f.setToken('changed');return {ok:true,user};});await f.c.syncQueueDrain();assert.equal(f.writes(),0);});

test('auth contract not hydrated cannot send an anonymous queued write',async()=>{const f=fixture();f.c.AUTH_V2.enabled=false;f.setQueue([f.item()]);await f.c.syncQueueDrain();assert.equal(f.writes(),0);});
