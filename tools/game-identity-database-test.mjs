import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
export async function verifyGameIdentity(db){
 const org=randomUUID(),other=randomUUID(),actor=randomUUID(),stranger=randomUUID(),role=randomUUID(),tag='game-scope-'+randomUUID(),subject=tag+'-legacy';
 await db.query("insert into organizations(id,name,slug) values($1,'Game RLS test',$3),($2,'Other Game RLS test',$3||'-other')",[org,other,tag]);
 for(const id of [actor,stranger]){await db.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.invalid']);await db.query("update profiles set identity_status='ACTIVE',status='Active' where id=$1",[id]);}
 await db.query("insert into organization_roles(id,organization_id,key,name) values($1,$2,'designer','Scoped game tester')",[role,org]);
 for(const id of [actor,stranger])await db.query("insert into organization_members(organization_id,user_id,role_id,status,joined_at) values($1,$2,$3,'ACTIVE',now())",[org,id,role]);
 await db.query("insert into records(id,coll,organization_id,data) values($1,'_accounts',$2,$3),($4,'gameScores',$2,$5)",[tag+'-account',org,{id:subject,status:'Active'},tag+'-score',{id:tag+'-score',userId:subject,score:7}]);
 await db.query("insert into legacy_identity_links(legacy_account_row_id,auth_user_id,link_status) values($1,$2,'CONFIRMED')",[tag+'-account',actor]);
 const as=async(uid,fn)=>{await db.query('savepoint role_test');try{await db.query('set local role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[uid]);return await fn();}finally{await db.query('rollback to savepoint role_test');}};
 const policy=async(o,coll,data)=>(await db.query('select records_can_write($1,$2,$3) v',[o,coll,data])).rows[0].v;
 await as(actor,async()=>{assert.equal(await policy(org,'gameScores',{userId:subject}),true);assert.equal(await policy(org,'gameStats',{userId:subject}),true);assert.equal(await policy(other,'gameScores',{userId:subject}),false);assert.equal(await policy(org,'activityLogs',{userId:subject}),false);assert.equal(await policy(org,'gameScores',{userId:'unmapped'}),false);const r=await db.query("insert into records(id,coll,organization_id,data) values($1,'gameScores',$2,$3) on conflict(id) do update set data=excluded.data returning id",[tag+'-score',org,{id:tag+'-score',userId:subject,createdBy:actor,score:8}]);assert.equal(r.rowCount,1);});
 await as(stranger,async()=>{assert.equal(await policy(org,'gameScores',{userId:subject}),false);await db.query('savepoint denied_write');try{await assert.rejects(db.query("insert into records(id,coll,organization_id,data) values($1,'gameScores',$2,$3) on conflict(id) do update set data=excluded.data",[tag+'-score',org,{id:tag+'-score',userId:subject,createdBy:stranger,score:99}]),{code:'42501'});}finally{await db.query('rollback to savepoint denied_write');}});
 await db.query("update legacy_identity_links set link_status='PENDING' where legacy_account_row_id=$1",[tag+'-account']);
 await as(actor,async()=>assert.equal(await policy(org,'gameScores',{userId:subject}),false));
 await db.query("update legacy_identity_links set link_status='CONFIRMED' where legacy_account_row_id=$1",[tag+'-account']);
 await db.query("update records set data=data||'{\"status\":\"Inactive\"}'::jsonb where id=$1",[tag+'-account']);
 await as(actor,async()=>assert.equal(await policy(org,'gameScores',{userId:subject}),false));
 await db.query("update records set data=data||'{\"status\":\"Active\"}'::jsonb where id=$1",[tag+'-account']);
 await db.query("insert into records(id,coll,organization_id,data) values($1,'_accounts',$2,$3)",[tag+'-conflict',org,{id:subject,status:'Active'}]);
 await db.query("insert into legacy_identity_links(legacy_account_row_id,auth_user_id,link_status) values($1,$2,'CONFIRMED')",[tag+'-conflict',stranger]);
 await as(actor,async()=>assert.equal(await policy(org,'gameScores',{userId:subject}),false));
 console.log('PASS confirmed legacy game subject: exact conflict update, unauthorized/tenant/unmapped/unconfirmed denial; other collections unchanged');
}
