#!/usr/bin/env node
'use strict';

// Read-only release gate: the public Production and Staging deployments must
// never resolve to the same Supabase project. It reads only the publishable
// runtime configuration and never prints API keys.

const { CURRENT_PRODUCTION_REF, PROTECTED_PROJECT_REFS } = require('./project-safety');

function parseArgs(argv) {
  const result = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const at = raw.indexOf('=');
    result[raw.slice(2, at < 0 ? undefined : at)] = at < 0 ? true : raw.slice(at + 1);
  }
  return result;
}

function exactDeployment(value, fallback) {
  const url = new URL(String(value || fallback));
  if (url.protocol !== 'https:' || ![
    'magnet-op.vercel.app',
    'magnet-os-staging.vercel.app',
    'magnet-os-v2-staging.vercel.app',
  ].includes(url.hostname)) throw new Error('Refused: use an exact approved MAGNET OS deployment URL.');
  return url.origin;
}

async function runtimeProjectRef(origin) {
  const response = await fetch(`${origin}/api/runtime-config`, { cache: 'no-store' });
  const body = await response.text();
  if (!response.ok) throw new Error(`${origin} runtime config returned HTTP ${response.status}.`);
  const match = body.match(/https:\/\/([a-z]{20})\.supabase\.co\/?/);
  if (!match) throw new Error(`${origin} runtime config has no valid Supabase project.`);
  return match[1];
}

(async () => {
  const args = parseArgs(process.argv);
  const production = exactDeployment(args.production, 'https://magnet-op.vercel.app');
  const staging = exactDeployment(args.staging, 'https://magnet-os-staging.vercel.app');
  const [productionRef, stagingRef] = await Promise.all([
    runtimeProjectRef(production),
    runtimeProjectRef(staging),
  ]);

  console.log(`Production project ref: ${productionRef}`);
  console.log(`Staging project ref:    ${stagingRef}`);

  let failed = false;
  if (productionRef !== CURRENT_PRODUCTION_REF) {
    console.error('FAIL: the documented current Production project does not match the live deployment.');
    failed = true;
  }
  if (productionRef === stagingRef || PROTECTED_PROJECT_REFS.has(stagingRef)) {
    console.error('FAIL: Staging is connected to a protected Production database.');
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('PASS: Production and Staging use separate Supabase projects.');
})().catch((error) => {
  console.error('Environment separation check failed: ' + String(error && error.message || error));
  process.exit(1);
});
