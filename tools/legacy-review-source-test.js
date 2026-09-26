'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {parseReview}=require('./legacy-review-source');
test('existing stable review IDs and grouped decisions are preserved without copying business values',()=>{const result=parseReview(fs.readFileSync('docs/LEGACY_DATA_REVIEW.md','utf8'));assert.equal(result.cases.length,173);assert.equal(result.groups,143);assert.equal(result.cases.find(c=>c.case_key==='STORAGE-001').metadata.objectId,'7aac6425-3752-4370-8c7f-650e15cb7297');assert.equal(result.cases.find(c=>c.case_key==='ASSET-001').metadata.field,'clientId');assert.ok(!JSON.stringify(result).includes('passwordHash'));assert.equal(result.cases.filter(c=>c.case_type==='ROLE').length,1);});
test('duplicate stable source IDs fail instead of overwriting decisions',()=>{const line='| TASK-001 | Test | Task `task-a`. |';assert.throws(()=>parseReview(line+'\n'+line),/Duplicate/);});
