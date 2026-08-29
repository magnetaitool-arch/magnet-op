#!/usr/bin/env node
'use strict';

// End-to-end test for the deployed, protected Vercel Staging preview and its
// separate Supabase project. Uses synthetic public-form records and cleans them.

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
const STABLE_STAGING_DEPLOYMENTS = new Set([
  'https://magnet-os-staging.vercel.app',
  'https://magnet-os-v2-staging.vercel.app',
]);

function argsOf(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const at = raw.indexOf('=');
    result[raw.slice(2, at < 0 ? undefined : at)] = at < 0 ? true : raw.slice(at + 1);
  }
  return result;
}

function safeText(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[REDACTED_EMAIL]')
    .slice(-3000);
}

function cliJson(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) throw new Error(safeText(result.stderr || result.stdout));
  const output = String(result.stdout || '');
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function vercelPost(deployment, path, payload) {
  const output = cliJson('pnpm', [
    'dlx', 'vercel@latest', 'curl', path, '--deployment', deployment, '--',
    '--silent', '--show-error', '--request', 'POST', '--header', 'Content-Type: application/json',
    '--header', `Origin: ${deployment}`,
    '--data', JSON.stringify(payload),
  ]);
  return output;
}

async function main() {
  const args = argsOf(process.argv);
  const projectRef = String(args['project-ref'] || '').trim();
  const deployment = String(args.deployment || '').replace(/\/$/, '');
  if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) throw new Error('Refused: non-Production project ref required.');
  const isImmutablePreview = /^https:\/\/magnet-[a-z0-9-]+-magnetaitool-archs-projects\.vercel\.app$/.test(deployment);
  if (!isImmutablePreview && !STABLE_STAGING_DEPLOYMENTS.has(deployment)) {
    throw new Error('Refused: explicit MAGNET OS Staging deployment URL required.');
  }

  const project = cliJson('pnpm', ['dlx', 'supabase@latest', 'projects', 'list', '--output', 'json'])
    .find((item) => item.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: target is not healthy MAGNET OS STAGING.');
  }
  const keys = cliJson('pnpm', ['dlx', 'supabase@latest', 'projects', 'api-keys', '--project-ref', projectRef, '--output', 'json']);
  const service = keys.find((item) => item.name === 'service_role') || keys.find((item) => item.type === 'secret');
  if (!service) throw new Error('Staging service key class unavailable.');

  const base = `https://${projectRef}.supabase.co`;
  const headers = { apikey: service.api_key, Authorization: `Bearer ${service.api_key}`, 'Content-Type': 'application/json' };
  const suffix = crypto.randomBytes(10).toString('hex');
  const slug = `public-canary-${suffix}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const campaignId = `public-campaign-${suffix}`;
  const briefId = `public-brief-${suffix}`;
  const createdIds = [campaignId, briefId];
  const assertions = [];
  const check = (condition, label) => {
    assertions.push({ pass: !!condition, label });
    if (!condition) throw new Error(`Assertion failed: ${label}`);
  };

  async function serviceRows(path, init = {}) {
    const result = await jsonFetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!result.response.ok) throw new Error(`Staging service request failed (${result.response.status})`);
    return result.body;
  }

  try {
    const organizations = await serviceRows('organizations?slug=eq.magnet&status=eq.ACTIVE&select=id&limit=1');
    const organizationId = organizations[0] && organizations[0].id;
    check(organizationId, 'Magnet organization exists');

    await serviceRows('records', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([
        { id: campaignId, coll: 'campaigns', organization_id: organizationId, data: { id: campaignId, slug, name: 'Synthetic Campaign', status: 'Active', headline: 'Synthetic headline', fields: ['name', 'email'] } },
        { id: briefId, coll: 'briefs', organization_id: organizationId, data: { id: briefId, token, status: 'pending', clientName: 'Synthetic Client', createdAt: new Date().toISOString() } },
      ]),
    });

    const campaign = vercelPost(deployment, '/api/public-form', { action: 'campaign.get', slug });
    check(campaign.ok === true && campaign.campaign && campaign.campaign.id === campaignId, 'public campaign is served through Vercel server route');
    check(!Object.prototype.hasOwnProperty.call(campaign.campaign, 'token'), 'campaign response exposes only allowlisted fields');

    const brief = vercelPost(deployment, '/api/public-form', { action: 'brief.get', token });
    check(brief.ok === true && brief.brief && brief.brief.id === briefId, 'tokenized brief is served through Vercel server route');
    check(!JSON.stringify(brief.brief).includes(token), 'brief response never echoes bearer token');

    const submitted = vercelPost(deployment, '/api/public-form', {
      action: 'brief.submit', token,
      answers: { contactName: 'Synthetic Client', company: 'Synthetic Company', email: 'synthetic@example.invalid', consent: true },
    });
    check(submitted.ok === true, 'brief submission succeeds through transactional RPC');
    const storedBrief = await serviceRows(`records?id=eq.${briefId}&select=data`);
    check(storedBrief[0] && storedBrief[0].data.status === 'submitted', 'brief submission persisted on Staging');

    const intakePayload = {
      type: 'lead', name: 'Synthetic Public Lead', email: 'synthetic@example.invalid', campaignId, campaignName: 'Synthetic Campaign', source: 'Automated Staging Test',
    };
    const intake = vercelPost(deployment, '/api/intake', intakePayload);
    check(intake.ok === true && /^lea-/.test(String(intake.id || '')), 'public lead intake succeeds without anonymous database access');
    createdIds.push(intake.id);
    const replay = vercelPost(deployment, '/api/intake', intakePayload);
    check(replay.ok === true && replay.id === intake.id && replay.replayed === true, 'repeated public intake is idempotent');
    const storedLead = await serviceRows(`records?id=eq.${encodeURIComponent(intake.id)}&select=organization_id,coll`);
    check(storedLead[0] && storedLead[0].organization_id === organizationId && storedLead[0].coll === 'leads', 'public intake stamps authoritative tenant');
    const queued = await serviceRows(`outbox_messages?organization_id=eq.${organizationId}&payload->>entityId=eq.${encodeURIComponent(intake.id)}&select=id,kind,status`);
    check(queued.length === 2 && queued.every((row) => row.status === 'PENDING'), 'public intake queues durable email and WhatsApp delivery');

    const relatedNotifications = await serviceRows(`records?coll=eq.notifications&organization_id=eq.${organizationId}&or=(data->>entityId.eq.${briefId},data->>entityId.eq.${encodeURIComponent(intake.id)})&select=id`);
    createdIds.push(...relatedNotifications.map((row) => row.id));
    check(relatedNotifications.length >= 2, 'brief and lead notifications were created');
  } finally {
    for (const id of [...new Set(createdIds)]) {
      await fetch(`${base}/rest/v1/records?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => null);
    }
    for (const id of createdIds) {
      await fetch(`${base}/rest/v1/outbox_messages?payload->>entityId=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => null);
      await fetch(`${base}/rest/v1/idempotency_keys?response_body->>id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => null);
    }
  }

  const leftovers = await serviceRows(`records?id=like.*${suffix}*&select=id`);
  check(leftovers.length === 0, 'all public-form canaries removed');
  const failed = assertions.filter((item) => !item.pass);
  process.stdout.write(`Public forms E2E: ${assertions.length - failed.length} passed, ${failed.length} failed. Synthetic records removed.\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Public forms E2E failed: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exitCode = 1;
});
