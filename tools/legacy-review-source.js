'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
function parseReview(source) {
  const cases = [];
  for (const line of source.split('\n')) {
    const match = line.match(/^\| (([A-Z]+)-\d{3}) \| (.*?) \| (.*?) \|$/);
    if (!match) continue;
    const [, key, type, description, context] = match;
    const ids = [...context.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(id => id !== 'unset');
    const group = description.match(/group (G\d+)/)?.[1];
    const field = description.match(/; (\w+) points/)?.[1];
    const refs = type === 'ROLE' ? [] : type === 'STORAGE' ? [] : [...new Set(ids)];
    cases.push({case_key:key,case_type:type,group_key:group?'CONTACT-'+group:key,title:key+' · '+type,description,context,record_ids:refs,
      metadata:{...(field?{field}:{}),...(type==='STORAGE'?{objectId:ids[0],bucket:description.match(/`([^`]+)`/)?.[1]}:{}),...(type==='ASSET'?{child:ids[0],parent:ids[1]}:{})},
      risk_level:['IDENTITY','FINANCE','STORAGE','ROLE','ASSET'].includes(type)?'HIGH':'MEDIUM'});
  }
  if (new Set(cases.map(c=>c.case_key)).size!==cases.length) throw Error('Duplicate stable case key');
  return {sha256:crypto.createHash('sha256').update(source).digest('hex'),cases,groups:new Set(cases.map(c=>c.group_key)).size};
}
module.exports={parseReview};
if(require.main===module){const result=parseReview(fs.readFileSync('docs/LEGACY_DATA_REVIEW.md','utf8'));if(result.cases.length!==173||result.groups!==143)throw Error('Review source count changed: explicit review required');fs.writeFileSync(process.argv[2]||'tmp/legacy-review-source.json',JSON.stringify(result,null,2));console.log('Parsed existing source: 173 cases / 143 grouped decisions; no business records copied');}
