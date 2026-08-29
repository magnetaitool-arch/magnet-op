#!/usr/bin/env node
'use strict';

// Staging-only regression test for M0-restored Auth placeholders. It proves the
// provider rejects the original NULL token-column shape, normalizes only the
// disposable canary, proves password update + password grant work, and removes
// the canary. No Production project, real account, or real credential is used.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';

function parseArgs(argv) {
  const output = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const separator = raw.indexOf('=');
    output[raw.slice(2, separator < 0 ? undefined : separator)] = separator < 0 ? true : raw.slice(separator + 1);
  }
  return output;
}

function safeText(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[REDACTED_EMAIL]')
    .slice(-3000);
}

function commandJson(args) {
  const command = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (command.status !== 0) throw new Error(safeText(command.stderr || command.stdout));
  const output = String(command.stdout || '');
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function query(projectRef, sql) {
  const payload = commandJson(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  return Array.isArray(payload.rows) ? payload.rows : [];
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const projectRef = String(parseArgs(process.argv)['project-ref'] || '').trim();
  if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
    throw new Error('Refused: an explicit non-Production project ref is required.');
  }
  const projects = commandJson(['projects', 'list', '--output', 'json']);
  const project = projects.find((candidate) => candidate.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not the healthy MAGNET OS STAGING project.');
  }
  const keys = commandJson(['projects', 'api-keys', '--project-ref', projectRef, '--output', 'json']);
  const publishable = keys.find((candidate) => candidate.type === 'publishable') || keys.find((candidate) => candidate.name === 'anon');
  const service = keys.find((candidate) => candidate.name === 'service_role') || keys.find((candidate) => candidate.type === 'secret');
  if (!publishable || !service) throw new Error('Required Staging API keys are unavailable.');

  const base = `https://${projectRef}.supabase.co`;
  const serviceHeaders = { apikey: service.api_key, Authorization: `Bearer ${service.api_key}`, 'Content-Type': 'application/json' };
  const userId = crypto.randomUUID();
  const email = `restored-auth-canary-${crypto.randomBytes(8).toString('hex')}@example.invalid`;
  const password = `RepairAa1-${crypto.randomBytes(18).toString('base64url')}`;
  const checks = [];
  const check = (condition, label) => {
    checks.push({ pass: !!condition, label });
    if (!condition) throw new Error(`Assertion failed: ${label}`);
  };

  try {
    query(projectRef, `
      insert into auth.users
        (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,
         raw_app_meta_data,raw_user_meta_data,is_super_admin,is_anonymous)
      values
        (coalesce((select id from auth.instances limit 1),'00000000-0000-0000-0000-000000000000'::uuid),
         ${quoteLiteral(userId)}::uuid,'authenticated','authenticated',${quoteLiteral(email)},null,now(),now(),now(),
         '{"provider":"email","providers":["email"],"staging_placeholder":false}'::jsonb,
         '{"magnet_auth_repair_canary":true}'::jsonb,false,false);
    `);
    check(true, 'original M0 placeholder shape created in Staging');

    const rejected = await jsonFetch(`${base}/auth/v1/admin/users/${userId}`, {
      method: 'PUT', headers: serviceHeaders,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    check(!rejected.response.ok, 'provider reproduces password-update failure for NULL token columns');

    query(projectRef, `
      update auth.users
      set confirmation_token=coalesce(confirmation_token,''),
          recovery_token=coalesce(recovery_token,''),
          email_change_token_new=coalesce(email_change_token_new,''),
          email_change=coalesce(email_change,''),
          updated_at=now()
      where id=${quoteLiteral(userId)}::uuid
        and raw_user_meta_data @> '{"magnet_auth_repair_canary":true}'::jsonb;
    `);
    const repaired = await jsonFetch(`${base}/auth/v1/admin/users/${userId}`, {
      method: 'PUT', headers: serviceHeaders,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    check(repaired.response.ok, 'provider accepts password update after token-column normalization');

    const session = await jsonFetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: publishable.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    check(session.response.ok && session.body && session.body.access_token, 'repaired Auth user receives a secure Supabase session');
  } finally {
    await fetch(`${base}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: serviceHeaders }).catch(() => null);
    const remaining = query(projectRef, `
      select count(*)::int as count from auth.users
      where id=${quoteLiteral(userId)}::uuid
         or raw_user_meta_data @> '{"magnet_auth_repair_canary":true}'::jsonb;
    `)[0] || {};
    check(Number(remaining.count) === 0, 'disposable Auth repair canary removed');
  }

  const failed = checks.filter((item) => !item.pass);
  process.stdout.write(`Restored Auth repair: ${checks.length - failed.length} passed, ${failed.length} failed. Canary removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Restored Auth repair failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
