import {expiredRecoveryObjects} from './backup-retention.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const env=process.env,ref=env.MAGNET_BACKUP_PROJECT_REF,org=env.MAGNET_BACKUP_ORGANIZATION_ID,key=env.MAGNET_BACKUP_STORAGE_SERVICE_KEY;
if(!/^[a-z]{20}$/.test(ref||'')||!/^[0-9a-f-]{36}$/.test(org||'')||!key)throw Error('Explicit backup project, organization and server credential required');
const base='https://'+ref+'.supabase.co',bucket='magnet-recovery',id=randomUUID(),prefix='snapshots/'+new Date().toISOString().replaceAll(':','-')+'-'+id;
async function request(path,method,body,type='application/json'){const r=await fetch(base+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':type},body:body===undefined?undefined:type==='application/json'?JSON.stringify(body):body,signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('backup_provider_'+r.status);return r;}
const evidence=async(state,data={})=>request('/rest/v1/rpc/record_backup_evidence_v3','POST',{p_org:org,p_id:randomUUID(),p_evidence:{state,...data}});
const directory=await mkdtemp(join(tmpdir(),'magnet-encrypted-backup-'));
function run(file,extra){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[file],{env:{...env,...extra},stdio:['ignore','ignore','pipe']});child.stderr.on('data',()=>{});child.on('error',()=>reject(Error('backup_export_failed')));child.on('exit',code=>code===0?resolve():reject(Error('backup_export_failed')));});}
try{
 if(env.MAGNET_BACKUP_SKIP_EVIDENCE!=='1')await evidence('STARTED');
 const probe=await fetch(base+'/storage/v1/bucket/'+bucket,{headers:{apikey:key,Authorization:'Bearer '+key}});
 if(probe.status===404||probe.status===400){await request('/storage/v1/bucket','POST',{id:bucket,name:bucket,public:false,file_size_limit:52428800,allowed_mime_types:['application/octet-stream','application/json']});}else{if(!probe.ok)throw Error('backup_bucket_unavailable');const b=await probe.json();if(b.public)throw Error('backup_bucket_must_be_private');}
 const db=join(directory,'database.aesgcm'),storage=join(directory,'storage.aesgcm');
 await run('tools/encrypted-backup.mjs',{MAGNET_BACKUP_OUTPUT:db});await run('tools/encrypted-storage-backup.mjs',{MAGNET_BACKUP_STORAGE_OUTPUT:storage});
 const receipts=[];
 for(const [name,path] of [['database.aesgcm',db],['database.manifest.json',db+'.manifest.json'],['storage.aesgcm',storage],['storage.manifest.json',storage+'.manifest.json']]){
  const bytes=await readFile(path),sha=createHash('sha256').update(bytes).digest('hex'),objectPath=bucket+'/'+prefix+'/'+name;
  await request('/storage/v1/object/'+objectPath,'POST',bytes,'application/octet-stream');
  const downloaded=Buffer.from(await(await request('/storage/v1/object/authenticated/'+objectPath,'GET')).arrayBuffer());
  if(createHash('sha256').update(downloaded).digest('hex')!==sha)throw Error('backup_remote_checksum_mismatch');receipts.push({name,sha256:sha,bytes:bytes.length});
 }
 const folders=[];for(let offset=0;offset<100000;offset+=1000){const r=await request('/storage/v1/object/list/'+bucket,'POST',{prefix:'snapshots',limit:1000,offset,sortBy:{column:'name',order:'asc'}});const batch=await r.json();if(!Array.isArray(batch))throw Error('backup_retention_inventory_failed');folders.push(...batch);if(batch.length<1000)break;if(offset===99000)throw Error('backup_retention_inventory_limit');}
 const expired=expiredRecoveryObjects(folders);for(let offset=0;offset<expired.length;offset+=100)await request('/storage/v1/object/'+bucket,'DELETE',{prefixes:expired.slice(offset,offset+100)});
 const sm=JSON.parse(await readFile(storage+'.manifest.json','utf8'));
 const receipt={state:'EXPORTED',archiveRef:bucket+'/'+prefix,checksum:receipts[0].sha256,offDevice:true,storageObjects:Number(sm.objects),retentionDays:30,scheduleActive:false};
 // Activation requires a real external scheduler; a manual invocation never asserts it.
 if(env.MAGNET_BACKUP_SKIP_EVIDENCE!=='1')await evidence('EXPORTED',receipt);
 console.log(JSON.stringify({ok:true,projectRef:ref,organizationId:org,...receipt,receipts,scheduler:'NOT_CONFIGURED',recoveryScope:'Existing Supabase project; independent encrypted copy still recommended for project loss.'}));
}catch(e){if(env.MAGNET_BACKUP_SKIP_EVIDENCE!=='1')try{await evidence('FAILED',{diagnosticCode:/^backup_[a-z0-9_]+$/.test(e.message)?e.message:'backup_failed'});}catch{}throw Error('Operational backup failed ('+(/^backup_[a-z0-9_]+$/.test(e.message)?e.message:'internal_error')+'); no successful recovery claim.');}
finally{await rm(directory,{recursive:true,force:true});}
