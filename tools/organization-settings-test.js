#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825183000_organization_settings_source_of_truth.sql');
const privacyMigration = read('supabase/migrations/20260825192000_organization_settings_internal_only.sql');
const app = read('index.html');
let passed = 0;
let failed = 0;
const check = (value, label) => {
  if (value) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
};

console.log('[1] server-authoritative organization settings');
check(/create table if not exists public\.organization_settings/.test(migration), 'versioned organization settings table exists');
check(/organization_id uuid primary key references public\.organizations/.test(migration), 'settings are tenant-owned with a foreign key');
check(/version bigint not null default 1/.test(migration), 'settings use optimistic concurrency');
check(/organization_settings_member_read/.test(migration) && /is_active_org_member/.test(migration), 'only active members can read settings');
check(/current_member_role_key\(organization_id\) <> 'client'/.test(privacyMigration), 'client portal cannot read operational settings');
check(/revoke all privileges on public\.organization_settings from public, anon, authenticated/.test(migration), 'direct browser writes are revoked');
check(/grant select on public\.organization_settings to authenticated/.test(migration), 'authenticated members receive read-only table access');

console.log('\n[2] validated capability-scoped commands');
check(/validate_organization_settings_patch/.test(migration) && /unsupported organization setting/.test(migration), 'unknown setting keys fail closed');
check(/organization\.manage/.test(migration) && /hr\.manage/.test(migration) && /finance\.manage/.test(migration) && /reports\.manage/.test(migration), 'setting categories require live capabilities');
check(/organization settings version conflict/.test(migration) && /errcode = '40001'/.test(migration), 'concurrent edits produce a detectable conflict');
check(/organization\.settings_updated/.test(migration) && /insert into public\.audit_events/.test(migration), 'setting changes emit append-only audit events');
check(!/before_data|after_data/.test(migration.match(/insert into public\.audit_events[\s\S]*?\);/i)?.[0] || ''), 'audit event stores changed keys rather than complete settings values');

console.log('\n[3] application hydration and privacy repairs');
check(/PERSONAL_SETTING_KEYS = new Set\(\['language','theme','soundAlerts'\]\)/.test(app), 'personal preferences remain device-local');
check(/cloudLoadOrganizationSettings/.test(app) && /organization_settings\?organization_id=eq\./.test(app), 'application hydrates the active tenant settings');
check(/cloudUpdateOrganizationSettings/.test(app) && /rpc\/update_organization_settings/.test(app), 'application saves through the authorized RPC');
check(/organizationSettingsVersion\.current/.test(app) && /err&&err\.status===409/.test(app), 'application reconciles version conflicts');
check(/clearLegacyOrganizationSettings/.test(app) && /One-time cutover preservation/.test(app), 'legacy device settings have a controlled one-time migration path');
check(/result\.version===1&&canBootstrap[\s\S]{0,700}cloudUpdateOrganizationSettings\(cfg\.current,patch,result\.version\)/.test(app), 'first authorized hydration permanently closes the legacy import window');
check(/a==='Admin' \|\| a==='HR'/.test(app.match(/const canEditEmployee[^\n]+/)?.[0] || ''), 'HR can edit employee profiles');
check(!/Project Manager/.test(app.match(/const canSeeEmployeePrivate[^\n]+/)?.[0] || '') && /a==='HR'/.test(app.match(/const canSeeEmployeePrivate[^\n]+/)?.[0] || ''), 'private employee data excludes Project Manager and includes HR');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
