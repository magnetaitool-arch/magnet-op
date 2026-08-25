#!/usr/bin/env node
'use strict';

// Offline structural tests for the staged SaaS foundation. These tests do not
// claim that a migration was applied or that production RLS is correct.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(ROOT, file));
let pass = 0;
let fail = 0;
const ok = (message) => { pass++; console.log('  ok   ' + message); };
const bad = (message) => { fail++; console.log('  FAIL ' + message); };
const check = (condition, message) => condition ? ok(message) : bad(message);

const viewMigration = 'supabase/migrations/20260816060242_harden_accounts_safe_view.sql';
const foundationMigration = 'supabase/migrations/20260816101341_saas_identity_tenancy_foundation.sql';

console.log('[1] required architecture deliverables');
for (const file of [
  'AGENTS.md',
  'docs/SAAS_READINESS_AUDIT.md',
  'docs/AUTH_ARCHITECTURE.md',
  'docs/ARCHITECTURE.md',
  'docs/DATABASE.md',
  'docs/DATABASE_ERD.md',
  'docs/DISASTER_RECOVERY.md',
  'docs/PHASE_1_IMPLEMENTATION.md',
  'docs/PRODUCTION_READINESS.md',
]) check(exists(file), file);

console.log('\n[2] account roster view hardening');
const viewSql = read(viewMigration);
check(/security_invoker\s*=\s*true/i.test(viewSql), 'accounts_safe uses invoker security');
check(/revoke all privileges on public\.accounts_safe from anon/i.test(viewSql), 'anon grant is revoked');
check(/revoke all privileges on public\.accounts_safe from authenticated/i.test(viewSql), 'authenticated direct grant is revoked');
check(/grant select on public\.accounts_safe to service_role/i.test(viewSql), 'service-role diagnostics retain sanitized access');
check(!/\b(drop|delete|truncate)\s+(table\s+)?public\.records\b/i.test(viewSql), 'view migration cannot delete legacy records');

console.log('\n[3] additive identity and tenancy foundation');
const foundation = read(foundationMigration);
for (const table of [
  'organizations', 'organization_roles', 'capabilities', 'role_capabilities',
  'organization_members', 'organization_invitations', 'auth_events', 'audit_events',
  'idempotency_keys', 'outbox_messages', 'jobs', 'legacy_record_tenant_map',
  'legacy_identity_links',
]) check(new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(foundation), `creates ${table}`);

check(/alter table public\.profiles add column if not exists identity_status/i.test(foundation), 'legacy profiles are upgraded in place');
check(/user_id uuid not null references public\.profiles\(id\)/i.test(foundation), 'memberships reference canonical Supabase Auth profile IDs');
check(/unique \(organization_id, user_id\)/i.test(foundation), 'membership is unique per user and organization');
check(/foreign key \(role_id, organization_id\)[\s\S]*references public\.organization_roles\(id, organization_id\)/i.test(foundation), 'membership/invite roles are tenant-scoped by composite foreign key');
check(/email_normalized text[\s\S]*generated always as \(lower\(btrim\(email\)\)\) stored/i.test(foundation), 'emails are normalized structurally');
check(!/create table if not exists public\.roles\b/i.test(foundation), 'canonical RBAC does not collide with the legacy roles table');
check(/prevent_event_mutation/i.test(foundation) && /append-only/i.test(foundation), 'auth and audit events are append-only');
check(/alter table public\.%I enable row level security/i.test(foundation), 'new tables enable RLS');
check(/revoke all privileges on public\.%I from anon/i.test(foundation), 'new tables fail closed for anon');
check(/revoke all privileges on public\.%I from authenticated/i.test(foundation), 'new tables fail closed until reviewed authenticated policies exist');
check(!/insert into public\.organizations/i.test(foundation), 'migration does not hardcode an organization');
check(!/passwordHash|pbkdf2\$/i.test(foundation), 'migration contains no passwords or legacy password verifiers');
check(!/\b(drop|delete|truncate)\s+(table\s+)?public\.records\b/i.test(foundation), 'foundation cannot delete legacy records');

console.log('\n[4] diagnostic tooling safety');
const exposureAudit = read('tools/audit-saas-readiness.js');
const authDiagnostic = read('tools/diagnose-auth.js');
check(!/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(exposureAudit), 'SaaS exposure audit is GET-only');
check(/payloads are never printed/i.test(exposureAudit), 'exposure audit documents payload redaction');
check(/SUPABASE_SERVICE_ROLE_KEY is required/i.test(authDiagnostic), 'auth reconciliation requires explicit service-role access');
check(/sha256/i.test(authDiagnostic) && /slice\(0, 12\)/.test(authDiagnostic), 'auth reconciliation pseudonymizes subjects');
check(!/console\.log\([^\n]*(password|token|email)/i.test(authDiagnostic), 'auth reconciliation does not directly print sensitive fields');

console.log('\n[5] runtime contract');
const pkg = JSON.parse(read('package.json'));
check(pkg.engines && pkg.engines.node === '>=22', 'Node 22+ is required');
check(pkg.scripts && pkg.scripts['audit:saas'], 'audit:saas command is registered');
check(pkg.scripts && pkg.scripts['diagnose:auth'], 'diagnose:auth command is registered');

console.log(`\nResult: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
