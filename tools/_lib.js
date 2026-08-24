// Magnet OS — shared helpers for the backup/restore tooling.
// Dependency-free (Node 22+): node:crypto, node:fs, global fetch.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_VERSION = '1.0';
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(REPO_ROOT, 'backups');

// The one and only production project, per AUDIT_REPORT.md assumption #1.
const DEFAULT_SUPABASE_URL = 'https://jdylrthffifbhyrrhuqd.supabase.co';

function loadDotEnv() {
  // Minimal .env loader so the tools work without adding the `dotenv` dependency.
  const p = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

function getConfig() {
  loadDotEnv();
  const url = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  // Prefer the service-role key (full read incl. _accounts, RLS-bypass). Fall back
  // to the publishable/anon key, which can still read whatever anon policy allows.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
  const keyKind = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role'
    : (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY) ? 'anon/publishable' : 'none';
  return { url, key, keyKind };
}

function restHeaders(key, extra) {
  const h = Object.assign({ apikey: key, 'Content-Type': 'application/json' }, extra || {});
  // JWT-style keys (service_role/anon) also need a Bearer Authorization header.
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  return h;
}

// Stable JSON stringify (sorted keys) so a checksum is reproducible regardless of
// property insertion order.
function stableStringify(value) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      return Object.keys(v).sort().reduce((o, k) => { o[k] = norm(v[k]); return o; }, {});
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

function checksum(payload) {
  return 'sha256:' + crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function collectionsSummary(records) {
  const out = {};
  for (const r of records || []) { const c = (r && r.coll) || '_unknown'; out[c] = (out[c] || 0) + 1; }
  return out;
}

// pad2 / timestamp string for filenames: magnet-os-backup-YYYY-MM-DD-HH-mm-ss
function stamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

function makeEnvelope({ source, project, records, extra }) {
  const recs = records || [];
  return Object.assign({
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    source,
    project: project || null,
    recordCount: recs.length,
    collections: collectionsSummary(recs),
    checksum: checksum(recs),
    records: recs,
  }, extra || {});
}

function writeBackup(envelope) {
  ensureBackupDir();
  const file = path.join(BACKUP_DIR, `magnet-os-backup-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2));
  return file;
}

// Fetch ALL rows from the records table, paginating past PostgREST's 1000-row cap.
async function fetchAllRecords({ url, key }, coll) {
  const out = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const q = 'records?select=id,coll,data,updated_at&order=id.asc' + (coll ? '&coll=eq.' + encodeURIComponent(coll) : '');
    const res = await fetch(url + '/rest/v1/' + q, {
      headers: Object.assign(restHeaders(key), { Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact' }),
    });
    if (!res.ok) throw new Error(`Supabase read failed (${res.status}): ${await res.text().catch(() => '')}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); args[k] = v === undefined ? true : v; }
    else args._.push(a);
  }
  return args;
}

module.exports = {
  BACKUP_VERSION, BACKUP_DIR, REPO_ROOT, DEFAULT_SUPABASE_URL,
  loadDotEnv, getConfig, restHeaders, stableStringify, checksum, collectionsSummary,
  stamp, ensureBackupDir, makeEnvelope, writeBackup, fetchAllRecords, readJson, parseArgs,
};
