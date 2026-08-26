'use strict';

// Server-only read/update bridge for public campaign and client-brief links.
// The browser never receives a database credential and anonymous PostgREST
// access stays closed. Brief tokens are bearer capabilities: never log them.

const crypto = require('node:crypto');

const ALLOWED_ORIGINS = new Set([
  'https://magnet-op.vercel.app',
  'https://magnet-os-staging.vercel.app',
  'http://127.0.0.1:4175',
  'http://localhost:4175',
]);
if (process.env.VERCEL_URL) ALLOWED_ORIGINS.add('https://' + String(process.env.VERCEL_URL).trim());

const clip = (value, size) => String(value == null ? '' : value).slice(0, size);
const safeSlug = (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || '')) && String(value).length <= 80;
const safeToken = (value) => /^[A-Za-z0-9_-]{16,256}$/.test(String(value || ''));

function respond(req, res, status, payload) {
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(payload);
}

function serviceHeaders(key, extra) {
  return Object.assign({
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  }, extra || {});
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

let organizationCache = null;
async function organizationId(base, key) {
  if (organizationCache) return organizationCache;
  const slug = String(process.env.SUPABASE_ORGANIZATION_SLUG || 'magnet').trim();
  const result = await jsonFetch(
    base + '/rest/v1/organizations?slug=eq.' + encodeURIComponent(slug) + '&status=eq.ACTIVE&deleted_at=is.null&select=id&limit=1',
    { headers: serviceHeaders(key) },
  );
  const id = result.response.ok && Array.isArray(result.payload) && result.payload[0] && result.payload[0].id;
  if (!id) {
    const error = new Error('organization_unavailable');
    error.upstreamStatus = result.response.status;
    throw error;
  }
  organizationCache = id;
  return id;
}

function campaignView(row) {
  const data = (row && row.data) || {};
  return {
    id: row.id,
    name: clip(data.name, 160),
    status: clip(data.status, 40),
    headline: clip(data.headline, 240),
    subtext: clip(data.subtext, 1000),
    buttonText: clip(data.buttonText, 100),
    accent: /^#[0-9a-f]{3,8}$/i.test(String(data.accent || '')) ? data.accent : '#C4FF3D',
    fields: Array.isArray(data.fields) ? data.fields.map((item) => clip(item, 60)).slice(0, 30) : [],
  };
}

function briefView(row) {
  const data = (row && row.data) || {};
  return {
    id: row.id,
    data: {
      status: clip(data.status, 40),
      clientName: clip(data.clientName, 200),
      company: clip(data.company, 200),
      projectType: data.projectType || '',
      answers: data.answers && typeof data.answers === 'object' ? data.answers : {},
      createdAt: data.createdAt || null,
      openedAt: data.openedAt || null,
      submittedAt: data.submittedAt || null,
    },
  };
}

function sanitizeAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_answers');
  const out = {};
  const entries = Object.entries(value).slice(0, 80);
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || '');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof rawValue === 'boolean') out[key] = rawValue;
    else if (Array.isArray(rawValue)) out[key] = rawValue.slice(0, 30).map((item) => clip(item, 1000));
    else out[key] = clip(rawValue, 5000);
  }
  if (JSON.stringify(out).length > 100000) throw new Error('answers_too_large');
  return out;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(req, res, 200, {});
  if (req.method !== 'POST') return respond(req, res, 405, { ok: false, error: 'method_not_allowed' });
  const origin = String(req.headers.origin || '');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return respond(req, res, 403, { ok: false, error: 'origin_not_allowed' });

  const rawSize = Number(req.headers['content-length'] || 0);
  if (rawSize > 150000) return respond(req, res, 413, { ok: false, error: 'payload_too_large' });

  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(base) || !key) {
    return respond(req, res, 503, { ok: false, error: 'service_not_configured' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || '');

  try {
    const orgId = await organizationId(base, key);

    if (action === 'campaign.get') {
      if (!safeSlug(body.slug)) return respond(req, res, 400, { ok: false, error: 'invalid_slug' });
      const path = '/rest/v1/records?organization_id=eq.' + encodeURIComponent(orgId)
        + '&coll=eq.campaigns&data->>slug=eq.' + encodeURIComponent(body.slug)
        + '&deleted_at=is.null&select=id,data&limit=1';
      const result = await jsonFetch(base + path, { headers: serviceHeaders(key) });
      const row = result.response.ok && Array.isArray(result.payload) && result.payload[0];
      if (!row || !['Active', ''].includes(String((row.data || {}).status || ''))) {
        return respond(req, res, 404, { ok: false, error: 'not_found' });
      }
      return respond(req, res, 200, { ok: true, campaign: campaignView(row) });
    }

    if (action === 'brief.get' || action === 'brief.open') {
      if (!safeToken(body.token)) return respond(req, res, 400, { ok: false, error: 'invalid_token' });
      const path = '/rest/v1/records?organization_id=eq.' + encodeURIComponent(orgId)
        + '&coll=eq.briefs&data->>token=eq.' + encodeURIComponent(body.token)
        + '&deleted_at=is.null&select=id,data&limit=1';
      const result = await jsonFetch(base + path, { headers: serviceHeaders(key) });
      const row = result.response.ok && Array.isArray(result.payload) && result.payload[0];
      if (!row) return respond(req, res, 404, { ok: false, error: 'not_found' });

      if (action === 'brief.open' && String((row.data || {}).status || '') === 'pending') {
        const next = Object.assign({}, row.data, { status: 'opened', openedAt: new Date().toISOString() });
        const opened = await fetch(base + '/rest/v1/records?id=eq.' + encodeURIComponent(row.id) + '&organization_id=eq.' + encodeURIComponent(orgId), {
          method: 'PATCH',
          headers: serviceHeaders(key, { Prefer: 'return=minimal' }),
          body: JSON.stringify({ data: next }),
        });
        if (!opened.ok) throw new Error('brief_open_failed');
      }
      return respond(req, res, 200, { ok: true, brief: briefView(row) });
    }

    if (action === 'brief.submit') {
      if (!safeToken(body.token)) return respond(req, res, 400, { ok: false, error: 'invalid_token' });
      const answers = sanitizeAnswers(body.answers);
      const notificationId = 'nt-' + crypto.randomUUID();
      const result = await jsonFetch(base + '/rest/v1/rpc/submit_public_brief', {
        method: 'POST',
        headers: serviceHeaders(key),
        body: JSON.stringify({
          p_organization_id: orgId,
          p_token: body.token,
          p_answers: answers,
          p_notification_id: notificationId,
        }),
      });
      if (!result.response.ok || !result.payload || result.payload.ok !== true) {
        return respond(req, res, result.response.ok ? 404 : 502, { ok: false, error: 'submit_failed' });
      }
      return respond(req, res, 200, { ok: true, alreadySubmitted: !!result.payload.alreadySubmitted });
    }

    return respond(req, res, 400, { ok: false, error: 'invalid_action' });
  } catch (error) {
    console.error('[public-form] request failed', {
      action: ['campaign.get', 'brief.get', 'brief.open', 'brief.submit'].includes(action) ? action : 'unknown',
      code: ['organization_unavailable', 'brief_open_failed'].includes(String(error && error.message))
        ? String(error.message)
        : 'unexpected',
      upstreamStatus: Number.isInteger(error && error.upstreamStatus) ? error.upstreamStatus : null,
      environment: String(process.env.VERCEL_ENV || 'unknown'),
    });
    return respond(req, res, 503, { ok: false, error: 'service_unavailable' });
  }
};
