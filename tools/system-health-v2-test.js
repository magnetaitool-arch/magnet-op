#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { handleSystemHealth, _test } = require('../server/system-health');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260826082633_system_health_v2.sql'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'system-health.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api', 'system-health.js'), 'utf8');
const checks = [];

function check(condition, label) {
  checks.push({ condition: !!condition, label });
  if (!condition) process.stderr.write(`FAIL: ${label}\n`);
}

check(/create or replace function public\.system_health_snapshot_v2\s*\(/i.test(migration), 'aggregate health RPC exists');
check(/security definer[\s\S]*set search_path = ''/i.test(migration), 'health RPC has a locked search path');
check(/has_org_capability\(p_organization_id, 'organization\.manage'\)/i.test(migration), 'health RPC requires live organization management capability');
check(/revoke all on function public\.system_health_snapshot_v2\(uuid\) from public, anon/i.test(migration), 'anonymous health execution is revoked');
check(/grant execute on function public\.system_health_snapshot_v2\(uuid\) to authenticated, service_role/i.test(migration), 'authenticated health execution is explicit');
check(!/jsonb_build_object\([^)]*recipient|jsonb_build_object\([^)]*payload/i.test(migration), 'health response does not serialize recipients or payloads');
check(/function SystemHealthView\(/.test(app), 'System Health UI exists');
check(/case 'systemHealth': return html/.test(app), 'System Health route exists');
check(/ADMIN_ONLY_SECTIONS[^\n]+systemHealth/.test(app), 'System Health is admin-only in client navigation');
check(/organization\.manage/.test(app.slice(app.indexOf('function SystemHealthView'), app.indexOf('function SystemQAView'))), 'System Health UI checks canonical capability');
check(/\/api\/system-health/.test(app), 'System Health UI uses its authenticated server endpoint');
check(!/setInterval\(/.test(app.slice(app.indexOf('function SystemHealthView'), app.indexOf('function SystemQAView'))), 'System Health does not waste bandwidth with polling');
check(/handleSystemHealth/.test(api), 'Vercel API delegates to the server module');
check(/Cache-Control[^\n]+no-store/.test(server), 'health responses cannot be cached');
check(/x-magnet-organization-id/.test(server) && /Bearer/.test(server), 'health API requires explicit tenant and JWT');

async function run() {
  const originalFetch = global.fetch;
  try {
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const unauthenticated = await handleSystemHealth({ method: 'GET', headers: {} }, {});
    check(unauthenticated.status === 401 && fetchCalls === 0, 'unauthenticated requests fail before Supabase');

    const forbiddenOrigin = await handleSystemHealth({ method: 'GET', headers: { origin: 'https://evil.example', authorization: 'Bearer token', 'x-magnet-organization-id': '11111111-1111-4111-8111-111111111111' } }, {
      SUPABASE_URL: 'https://xqqgbvigfojfydzfguan.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
    });
    check(forbiddenOrigin.status === 403, 'untrusted origins are rejected');

    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true, checkedAt: '2026-08-26T08:00:00Z', organization: { status: 'ACTIVE' },
        database: { status: 'HEALTHY', publicTables: 40, businessRecords: 1700 },
        auth: { activeProfiles: 14, memberships: 14 }, storage: { objects: 2, bytes: 100 },
        outbox: { statuses: { DELIVERED: 10 }, oldestReadyAgeSeconds: 0 }, jobs: { statuses: {}, oldestReadyAgeSeconds: 0 },
      }),
    });
    const env = {
      SUPABASE_URL: 'https://xqqgbvigfojfydzfguan.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-secret-value',
      RESEND_API_KEY: 'resend-secret-value', FROM_EMAIL: 'Magnet <mail@example.test>', OUTBOX_WORKER_SECRET: 'worker-secret-value',
      VERCEL_ENV: 'preview', VERCEL_REGION: 'iad1', VERCEL_GIT_COMMIT_SHA: '1234567890abcdef',
    };
    const healthy = await handleSystemHealth({ method: 'GET', headers: { authorization: 'Bearer user-jwt-value', 'x-magnet-organization-id': '11111111-1111-4111-8111-111111111111' } }, env);
    const serialized = JSON.stringify(healthy.body);
    check(healthy.status === 200 && healthy.body.status === 'HEALTHY', 'healthy snapshot returns an actionable overall state');
    check(healthy.body.providers.email.status === 'CONFIGURED' && healthy.body.providers.worker.status === 'CONFIGURED', 'provider readiness is reported as booleans/statuses only');
    check(!serialized.includes('server-secret-value') && !serialized.includes('resend-secret-value') && !serialized.includes('worker-secret-value') && !serialized.includes('user-jwt-value'), 'health response never exposes credentials');
    check(healthy.body.deployment.commit === '1234567', 'deployment metadata is safely shortened');

    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ message: 'organization_manage_capability_required' }) });
    const denied = await handleSystemHealth({ method: 'GET', headers: { authorization: 'Bearer user-jwt', 'x-magnet-organization-id': '11111111-1111-4111-8111-111111111111' } }, env);
    check(denied.status === 403 && denied.body.error === 'system_health_not_allowed', 'limited users receive no health snapshot');

    const providerState = _test.providerSnapshot({});
    const warnings = _test.healthWarnings({ outbox: { statuses: { FAILED: 2 }, oldestReadyAgeSeconds: 901 }, jobs: { statuses: { DEAD: 1 }, oldestReadyAgeSeconds: 0 } }, providerState);
    check(warnings.some((warning) => warning.code === 'OUTBOX_FAILURES') && warnings.some((warning) => warning.code === 'DEAD_JOBS'), 'delivery and job failures produce action warnings');
  } finally {
    global.fetch = originalFetch;
  }

  const failed = checks.filter((item) => !item.condition);
  if (failed.length) {
    process.stderr.write(`System Health V2: ${checks.length - failed.length} passed, ${failed.length} failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`System Health V2: ${checks.length} passed, 0 failed.\n`);
}

run().catch((error) => {
  process.stderr.write(`System Health V2 crashed: ${String(error && error.message || error)}\n`);
  process.exit(1);
});
