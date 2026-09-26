import fs from 'node:fs';import {createRequire} from 'node:module';const require=createRequire(import.meta.url),{parseReview}=require('./legacy-review-source.js');
const source=parseReview(fs.readFileSync('docs/LEGACY_DATA_REVIEW.md','utf8'));
if(!process.argv.includes('--apply')){console.log(JSON.stringify({dryRun:true,cases:source.cases.length,groups:source.groups,sourceHash:source.sha256,businessRepairs:0}));process.exit(0);}
const url=process.env.SUPABASE_URL,org=process.env.MAGNET_REVIEW_ORGANIZATION_ID,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(url||'')||!/^[0-9a-f-]{36}$/.test(org||'')||!key)throw Error('Explicit server URL, organization and server credential required');
const r=await fetch(url+'/rest/v1/rpc/import_legacy_review_v3',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_org:org,p_cases:source.cases,p_source_hash:source.sha256}),signal:AbortSignal.timeout(30000)});
if(!r.ok)throw Error('Legacy case import rejected; no successful import claimed');const out=await r.json();if(!out.ok||out.sourceCases!==source.cases.length)throw Error('Import counts did not reconcile');console.log(JSON.stringify({...out,sourceHash:source.sha256,businessRepairs:0}));
