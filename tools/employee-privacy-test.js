#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825190000_employee_directory_privacy.sql');
const internalMigration = read('supabase/migrations/20260825191500_employee_directory_internal_members_only.sql');
const app = read('index.html');
const directorySql = (internalMigration.match(/create or replace function public\.employee_directory[\s\S]*?grant execute on function public\.employee_directory[\s\S]*?;/i) || [''])[0];
let passed = 0;
let failed = 0;
const check = (condition, label) => {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
};

console.log('[1] database privacy boundary');
check(/if p_collection = 'employees'[\s\S]*hr\.sensitive\.read[\s\S]*record_matches_current_user/i.test(migration), 'full employee rows require sensitive-HR access or self scope');
check(/p_data->>'id'/.test(migration), 'employee self-scope includes the employee record id');
check(/active organization membership required/.test(directorySql), 'directory requires an active tenant membership');
check(/current_member_role_key\(p_organization_id\) = 'client'/.test(directorySql), 'client portal identities cannot enumerate staff');
check(/record\.organization_id = p_organization_id/.test(directorySql), 'directory is tenant scoped');
check(/p_since is null or record\.updated_at > p_since/.test(directorySql), 'directory supports low-egress deltas');
check(/'_directoryOnly', true/.test(directorySql), 'directory rows are explicitly marked as redacted');
for (const field of ['salary','bankAccount','bankName','nationalId','nationalIdLink','email','phone','notes','performanceScore']) {
  check(!new RegExp("'" + field + "'", 'i').test(directorySql), `directory excludes ${field}`);
}
check(/revoke all on function public\.employee_directory\(uuid, timestamptz\) from public, anon/i.test(migration), 'anonymous directory execution is revoked');

console.log('\n[2] application authorization projection');
check(/rpc\/employee_directory/.test(app), 'app loads the sanitized employee directory RPC');
check(/currentIdentityHasCapability\('hr\.sensitive\.read'\)/.test(app), 'sensitive roles avoid redacted duplicate rows');
check(/const directory=await cloudLoadEmployeeDirectory\(cfg,null\)/.test(app), 'full load combines authorized records with directory rows');
check(/cloudLoadEmployeeDirectory\(cfg,since\)/.test(app), 'delta load includes directory changes');
check(/applyCloudDelta\(prev,d\.rows,d\.directory\)/.test(app), 'directory deltas reach the UI state');
check(/\[authReady,authUser&&authUser\.id,authScopeKey\]/.test(app), 'role/capability changes trigger a fresh authorized load');
check(/complete authorized projection[\s\S]{0,240}setDb\(d\)/.test(app), 'authorized full load replaces stale role data');
check(/setDb\(emptyDB\(\)\).*setAuthUser\(null\)/.test(app), 'logout and rejected sessions purge cached private rows');
check(/Credentials were accepted, but the authorized workspace could not be loaded safely/.test(app), 'mandatory login fails closed when authorized data cannot load');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
