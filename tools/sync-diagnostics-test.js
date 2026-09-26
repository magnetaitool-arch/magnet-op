const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
test('sync diagnostics expose scoped identifiers without pending record contents or credentials',()=>{
 const scope={authUserId:'actor',organizationId:'tenant'};
 const own={...scope,type:'upsert',coll:'comments',rec:{id:'r1',clientId:'client',projectId:'project',userId:'actor',body:'PRIVATE',password:'SECRET'},lastFailure:{status:403,code:'42501',message:'PRIVATE'}};
 const list=[own,{...own,authUserId:'other'}];
 const c={getSessionUser:()=>scope,activeOrganizationId:()=>scope.organizationId,syncQueueLoad:()=>list,syncFailureCode:v=>String(v||'request_failed')};vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('function syncQueueScope(){'),html.indexOf('function syncQueueSave('))+html.slice(html.indexOf('function syncQueueDiagnostics(){'),html.indexOf('function syncQueueChip(')),c);
 const d=JSON.parse(JSON.stringify(c.syncQueueDiagnostics()));assert.equal(d.length,1);assert.equal(d[0].recordId,'r1');assert.equal(d[0].status,403);assert.equal(d[0].organizationId,'tenant');assert.equal(d[0].endpoint,'/rest/v1/records?on_conflict=id');assert.doesNotMatch(JSON.stringify(d),/PRIVATE|SECRET|password|body/);
});
