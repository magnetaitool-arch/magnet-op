import {readFile} from 'node:fs/promises';import {createHash,randomUUID} from 'node:crypto';
const env=process.env,ref=env.MAGNET_BACKUP_PROJECT_REF,org=env.MAGNET_BACKUP_ORGANIZATION_ID,key=env.MAGNET_BACKUP_STORAGE_SERVICE_KEY;
if(!/^[a-z]{20}$/.test(ref||'')||!/^[0-9a-f-]{36}$/.test(org||'')||!key)throw Error('Backup health reporting is not configured');
let evidence={state:'FAILED',diagnosticCode:'scheduled_backup_failed'};
if(process.argv[2]==='success'){
 const bytes=await readFile(env.MAGNET_BACKUP_OUTPUT),sm=JSON.parse(await readFile(env.MAGNET_BACKUP_STORAGE_OUTPUT+'.manifest.json','utf8'));
 if(!/^https:\/\/github\.com\//.test(env.MAGNET_BACKUP_ARTIFACT_URL||''))throw Error('Successful artifact receipt required');
 const scheduled=env.GITHUB_EVENT_NAME==='schedule',next=new Date();next.setUTCHours(1,20,0,0);if(next<=new Date())next.setUTCDate(next.getUTCDate()+1);
 evidence={state:'EXPORTED',archiveRef:env.MAGNET_BACKUP_ARTIFACT_URL,checksum:createHash('sha256').update(bytes).digest('hex'),storageObjects:sm.objects,offDevice:true,retentionDays:30,scheduleActive:scheduled,nextRunAt:scheduled?next.toISOString():null};
}
const response=await fetch('https://'+ref+'.supabase.co/rest/v1/rpc/record_backup_evidence_v3',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_org:org,p_id:randomUUID(),p_evidence:evidence}),signal:AbortSignal.timeout(20000)});
if(!response.ok)throw Error('Backup evidence was not accepted');console.log('Backup receipt recorded; health is evaluated from actual evidence');
