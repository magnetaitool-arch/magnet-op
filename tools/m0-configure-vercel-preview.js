#!/usr/bin/env node
'use strict';

/**
 * Configure only Vercel Preview/Development to use the separate M0 Supabase
 * Staging project. The script fails closed if a target variable is shared with
 * Production. It never removes environment-variable records and audits email
 * isolation without mutating email settings. Secret values are passed through
 * stdin and never printed or written to disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const pos = raw.indexOf('=');
    if (pos === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, pos)] = raw.slice(pos + 1);
  }
  return out;
}

function safeError(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .slice(-3000);
}

function run(node, entry, args, options = {}) {
  const result = spawnSync(node, [entry, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(safeError(result.stderr || result.stdout));
  }
  return result;
}

function jsonFrom(result) {
  const stdout = String(result.stdout || '');
  const arrayStart = stdout.indexOf('[');
  const objectStart = stdout.indexOf('{');
  const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) throw new Error('CLI returned no JSON payload.');
  return JSON.parse(stdout.slice(start));
}

const args = parseArgs(process.argv);
const productionRef = String(args['production-ref'] || '').trim();
const stagingRef = String(args['staging-ref'] || '').trim();
const expectedStagingName = String(args['expected-staging-name'] || 'MAGNET OS STAGING');
const expectedVercelProjectId = String(args['vercel-project-id'] || '').trim();
const expectedVercelProjectName = String(args['vercel-project-name'] || 'magnet-op').trim();
const supabaseCli = path.resolve(String(args['supabase-cli-js'] || ''));
const vercelCli = path.resolve(String(args['vercel-cli-js'] || ''));

if (!/^[a-z]{20}$/.test(productionRef) || !/^[a-z]{20}$/.test(stagingRef) || stagingRef === productionRef) {
  console.error('REFUSED: explicit, different Production and Staging refs are required.');
  process.exit(2);
}
if (!expectedVercelProjectId || !fs.existsSync(supabaseCli) || !fs.existsSync(vercelCli)) {
  console.error('ERROR: expected Vercel project ID and installed CLI entrypoints are required.');
  process.exit(2);
}

const linkFile = path.resolve('.vercel/project.json');
if (!fs.existsSync(linkFile)) {
  console.error('REFUSED: this workspace is not linked to a Vercel project.');
  process.exit(2);
}
const linked = JSON.parse(fs.readFileSync(linkFile, 'utf8'));
if (linked.projectId !== expectedVercelProjectId || linked.projectName !== expectedVercelProjectName) {
  console.error('REFUSED: linked Vercel project identity does not match the approved Magnet OS project.');
  process.exit(2);
}

const projects = jsonFrom(run(process.execPath, supabaseCli, ['projects', 'list', '--output', 'json']));
const staging = projects.find((project) => project.ref === stagingRef);
if (!staging || staging.name !== expectedStagingName || staging.status !== 'ACTIVE_HEALTHY') {
  console.error('REFUSED: Supabase Staging project identity/name/health check failed.');
  process.exit(2);
}

const apiKeys = jsonFrom(run(process.execPath, supabaseCli, [
  'projects', 'api-keys', '--project-ref', stagingRef, '--output', 'json',
]));
const publishable = apiKeys.find((key) => key.type === 'publishable') || apiKeys.find((key) => key.name === 'anon');
const stagingAnonKey = publishable && publishable.api_key;
if (!stagingAnonKey || (!String(stagingAnonKey).startsWith('sb_publishable_') && !String(stagingAnonKey).startsWith('eyJ'))) {
  console.error('ERROR: Staging publishable key could not be resolved securely.');
  process.exit(2);
}

const stagingUrl = `https://${stagingRef}.supabase.co`;
const target = 'preview,development';
const variables = [
  ['SUPABASE_URL', stagingUrl],
  ['SUPABASE_ANON_KEY', stagingAnonKey],
  // api/intake.js reads SUPABASE_KEY. Use the publishable Staging key for the
  // current public-intake RLS baseline; never expose a service-role key.
  ['SUPABASE_KEY', stagingAnonKey],
];

const envInventory = jsonFrom(run(process.execPath, vercelCli, ['env', 'ls', '--json']));
const envEntries = Array.isArray(envInventory) ? envInventory : (envInventory.envs || []);
const targetsOf = (entry) => {
  const raw = entry && (entry.target || entry.targets);
  return Array.isArray(raw) ? raw.map(String) : (raw ? [String(raw)] : []);
};

for (const [name] of variables) {
  const existing = envEntries.filter((entry) => entry && entry.name === name);
  if (existing.some((entry) => targetsOf(entry).includes('production'))) {
    console.error(`REFUSED: ${name} is shared with Production; split it manually in the Vercel dashboard first.`);
    process.exit(2);
  }
}

for (const [name, value] of variables) {
  run(process.execPath, vercelCli, [
    'env', 'add', name, target, '--force', '--yes', '--no-sensitive',
  ], { input: `${value}\n` });
}

// Preview/Development must not inherit Production email delivery credentials.
// This is audit-only because Vercel can represent several targets in one env
// record; deleting a single scope through the CLI can delete the shared record.
const emailNames = new Set(['EMAIL_SHARED_SECRET', 'RESEND_API_KEY', 'RESEND_API_KEYY', 'FROM_EMAIL']);
const leakedEmailScopes = envEntries
  .filter((entry) => entry && emailNames.has(entry.name))
  .filter((entry) => targetsOf(entry).some((item) => item === 'preview' || item === 'development'))
  .map((entry) => entry.name);
if (leakedEmailScopes.length) {
  console.error(`REFUSED: Production email variables still target Preview/Development: ${[...new Set(leakedEmailScopes)].join(', ')}`);
  console.error('Split those records manually in the Vercel dashboard; this script will not delete them.');
  process.exit(2);
}

console.log(`Verified Vercel project: ${expectedVercelProjectName}`);
console.log(`Preview/Development Supabase variables configured: ${variables.map(([name]) => name).join(', ')}`);
console.log(`Production Supabase environment changed: false`);
console.log('Preview/Development production-email scope audit: isolated');
console.log('No environment values were printed or written to disk.');
