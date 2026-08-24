'use strict';

// Read-only production exposure probe. It never sends mutations and never prints
// row payloads, public keys, URLs containing keys, personal data, or secrets.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function publicConfig() {
  const url = process.env.SUPABASE_URL || (app.match(/https:\/\/[a-z0-9]+\.supabase\.co/i) || [])[0];
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY ||
    (app.match(/sb_publishable_[A-Za-z0-9_-]+/) || app.match(/eyJ[A-Za-z0-9._-]{80,}/) || [])[0];
  if (!url || !key) throw new Error('Public Supabase URL/key not found. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  return { url: url.replace(/\/$/, ''), key };
}

function contentCount(response) {
  const range = response.headers.get('content-range') || '';
  const total = range.includes('/') ? range.split('/').pop() : 'unknown';
  return total === '*' ? 'unknown' : total;
}

async function sampleCollection(cfg, coll) {
  const url = new URL(cfg.url + '/rest/v1/records');
  url.searchParams.set('select', 'id');
  url.searchParams.set('coll', 'eq.' + coll);
  url.searchParams.set('limit', '1');
  const response = await fetch(url, { headers: { apikey: cfg.key, Prefer: 'count=exact' } });
  let body = null;
  try { body = await response.json(); } catch (_) {}
  return {
    name: coll,
    status: response.status,
    visible: Array.isArray(body) ? body.length : null,
    total: contentCount(response),
  };
}

async function sampleView(cfg, view) {
  const url = new URL(cfg.url + '/rest/v1/' + view);
  url.searchParams.set('select', 'id');
  url.searchParams.set('limit', '1');
  const response = await fetch(url, { headers: { apikey: cfg.key, Prefer: 'count=exact' } });
  let body = null;
  try { body = await response.json(); } catch (_) {}
  return {
    name: view,
    status: response.status,
    visible: Array.isArray(body) ? body.length : null,
    total: contentCount(response),
  };
}

async function main() {
  const cfg = publicConfig();
  const privateCollections = [
    'clients', 'contacts', 'leads', 'tasks', 'deliverables', 'reports',
    'employees', 'attendance', 'leaves', 'employeePayments', 'salaryChanges',
    'invoices', 'payments', 'expenses', 'partnerSettlements', 'partnerTx',
    'approvalRequests', 'clientAssets', 'chatMessages', 'files', 'comments',
  ];

  console.log('Magnet OS SaaS exposure audit (read-only; payloads are never printed)');
  const results = [];
  for (const coll of privateCollections) results.push(await sampleCollection(cfg, coll));
  results.push(await sampleView(cfg, 'accounts_safe'));

  const exposed = results.filter((item) => item.visible > 0);
  for (const item of results) {
    const marker = item.visible > 0 ? 'EXPOSED' : (item.status >= 400 ? 'DENIED' : 'NO VISIBLE ROWS');
    console.log(`${marker.padEnd(16)} ${item.name.padEnd(22)} HTTP ${item.status} sampled=${item.visible == null ? 'n/a' : item.visible} total=${item.total}`);
  }

  if (exposed.length) {
    console.error(`\nFAIL: ${exposed.length} private collection/view target(s) exposed to the public key.`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: no sampled private rows were visible. Complete RLS tests are still required.');
  }
}

main().catch((error) => {
  console.error('Audit could not complete:', error && error.message ? error.message : String(error));
  process.exitCode = 2;
});
