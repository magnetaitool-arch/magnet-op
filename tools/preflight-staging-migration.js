#!/usr/bin/env node
'use strict';

// Executes a committed migration inside a transaction that is forced to roll
// back. This validates SQL against the real restored Staging schema without
// changing Staging or relying on a local schema approximation.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRODUCTION_REF = 'jdylrthffifbhyrrhuqd';
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const separator = raw.indexOf('=');
    result[raw.slice(2, separator < 0 ? undefined : separator)] = separator < 0 ? true : raw.slice(separator + 1);
  }
  return result;
}

function safeText(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/(password|token|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .slice(-6000);
}

function runSupabase(args) {
  const command = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  if (command.status !== 0) throw new Error(safeText(command.stderr || command.stdout));
  return String(command.stdout || '');
}

function parseJsonOutput(output) {
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('Supabase CLI returned no JSON payload.');
  return JSON.parse(output.slice(start));
}

function main() {
  const args = parseArgs(process.argv);
  const projectRef = String(args['project-ref'] || '').trim();
  const sourcePath = path.resolve(ROOT, String(args.file || ''));
  const migrationRoot = path.join(ROOT, 'supabase', 'migrations') + path.sep;

  if (!/^[a-z]{20}$/.test(projectRef) || projectRef === PRODUCTION_REF) {
    throw new Error('Refused: an explicit non-Production Supabase project ref is required.');
  }
  if (!sourcePath.startsWith(migrationRoot) || !sourcePath.endsWith('.sql') || !fs.existsSync(sourcePath)) {
    throw new Error('Refused: --file must point to a committed-style SQL file under supabase/migrations/.');
  }

  const projects = parseJsonOutput(runSupabase(['projects', 'list', '--output', 'json']));
  const project = projects.find((candidate) => candidate.ref === projectRef);
  if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
    throw new Error('Refused: the target is not the healthy MAGNET OS STAGING project.');
  }

  const source = fs.readFileSync(sourcePath, 'utf8');
  if (!/^(?:\s*--[^\n]*\n)*\s*begin\s*;/i.test(source) || !/commit\s*;\s*(?:--[^\n]*\n?\s*)*$/i.test(source)) {
    throw new Error('Refused: migration must have an explicit outer BEGIN and final COMMIT.');
  }
  const preflightSql = source.replace(/commit\s*;(?=\s*(?:--[^\n]*\n?\s*)*$)/i, 'rollback;');
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnetos-migration-preflight-'));
  fs.chmodSync(temporaryDir, 0o700);
  const temporaryFile = path.join(temporaryDir, path.basename(sourcePath));

  try {
    fs.writeFileSync(temporaryFile, preflightSql, { mode: 0o600 });
    runSupabase([
      'db', 'query', '--linked', '--project-ref', projectRef,
      '--file', temporaryFile, '--output', 'json',
    ]);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }

  process.stdout.write(`PASS: ${path.basename(sourcePath)} validated on ${EXPECTED_STAGING_NAME} and rolled back.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL: ${safeText(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}
