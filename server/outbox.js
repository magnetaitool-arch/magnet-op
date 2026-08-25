'use strict';

const crypto = require('node:crypto');

function normalOrigin(value) {
  try { return new URL(String(value || '')).origin; } catch (error) { return ''; }
}

function allowedOrigins(env) {
  const configured = String(env.EMAIL_ALLOWED_ORIGINS || '').split(',').map((item) => normalOrigin(item.trim())).filter(Boolean);
  const deployment = env.VERCEL_URL ? normalOrigin('https://' + env.VERCEL_URL) : '';
  return new Set(['https://magnet-op.vercel.app', 'https://magnet-os-staging.vercel.app', deployment, ...configured].filter(Boolean));
}

function responseHeaders(origin, env) {
  const headers = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-magnet-secret, x-outbox-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  const normalized = normalOrigin(origin);
  if (normalized && allowedOrigins(env).has(normalized)) headers['Access-Control-Allow-Origin'] = normalized;
  return headers;
}

function clip(value, size) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, size);
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value, encoding = 'base64url') {
  return crypto.createHash('sha256').update(String(value)).digest(encoding);
}

function serverConfig(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(base) || !key) return null;
  return { base, key };
}

function bearerToken(headers) {
  const match = String(headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function serviceHeaders(key, bearer) {
  return { apikey: key, Authorization: 'Bearer ' + (bearer || key), 'Content-Type': 'application/json' };
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function rpc(config, name, payload, bearer) {
  return jsonFetch(config.base + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: serviceHeaders(config.key, bearer), body: JSON.stringify(payload || {}),
  });
}

function emailArray(value) {
  const list = (Array.isArray(value) ? value : [value]).map((item) => clip(item, 320).toLowerCase()).filter(Boolean);
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return list.length && list.length <= 10 && list.every((item) => pattern.test(item)) ? [...new Set(list)] : null;
}

function inferPurpose(body) {
  const explicit = clip(body.purpose, 40).toUpperCase();
  if (explicit) return explicit;
  const key = clip(body.idempotencyKey, 200).toLowerCase();
  const subject = clip(body.subject, 200).toLowerCase();
  if (key.startsWith('task-assigned/')) return 'TASK_ASSIGNMENT';
  if (key.startsWith('payslip/')) return 'PAYSLIP';
  if (key.startsWith('employee-report/')) return 'EMPLOYEE_REPORT';
  if (/verify|password|account/.test(subject)) return 'USER_ADMIN';
  if (/invoice|contract|proposal|quotation|receipt/.test(subject)) return 'DOCUMENT';
  return 'NOTIFICATION';
}

function validEmailPayload(body) {
  const organizationId = clip(body && body.organizationId, 40);
  const recipients = emailArray(body && body.to);
  const subject = clip(body && body.subject, 200);
  const html = body && body.html == null ? '' : String(body.html);
  const text = body && body.text == null ? '' : String(body.text);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) return null;
  if (!recipients || !subject || /[\r\n]/.test(subject) || (!html && !text)) return null;
  if (html.length > 150000 || text.length > 150000) return null;
  const purpose = inferPurpose(body || {});
  const canonical = { organizationId, purpose, recipients, subject, html, text };
  const rawKey = clip(body && body.idempotencyKey, 200);
  const idempotencyKey = /^[A-Za-z0-9_./:-]{8,200}$/.test(rawKey) ? rawKey : 'email:' + digest(stableStringify(canonical), 'hex');
  return { organizationId, purpose, recipients, subject, html, text, idempotencyKey, requestHash: digest(stableStringify(canonical)) };
}

function publicEmailText(message, env) {
  const payload = message.payload || {};
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields : {};
  const lines = [clip(payload.title, 200), '', clip(payload.message, 2000)];
  for (const [key, value] of Object.entries(fields)) if (value) lines.push(`${clip(key, 50)}: ${clip(value, 2000)}`);
  if (payload.submittedAt) lines.push('submittedAt: ' + clip(payload.submittedAt, 80));
  if (payload.deepLinkPath) lines.push('', clip(env.MAGNET_APP_URL || 'https://magnet-os-staging.vercel.app', 500).replace(/\/$/, '') + clip(payload.deepLinkPath, 500));
  return lines.join('\n');
}

function configuredRecipient(message, env) {
  const mapping = {
    HR_EMAIL: 'HR_EMAIL', SALES_EMAIL: 'SALES_EMAIL',
    HR_WHATSAPP: 'HR_WHATSAPP', SALES_WHATSAPP: 'SALES_WHATSAPP',
  };
  const key = mapping[message.recipient_ref];
  return key ? clip(env[key], 320) : '';
}

async function deliverEmail(message, env) {
  const providerKey = String(env.RESEND_API_KEY || '');
  const from = clip(env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>', 320);
  const payload = message.payload || {};
  const recipients = message.kind === 'EMAIL_INTERNAL' ? emailArray(payload.to) : emailArray(configuredRecipient(message, env));
  if (!providerKey || !recipients) return { outcome: 'FAILED', provider: 'resend', providerStatus: 'not_configured', errorCategory: 'CONFIGURATION_MISSING' };
  const subject = clip(payload.subject || ('[Magnet OS] ' + clip(payload.title, 160)), 200);
  const text = message.kind === 'EMAIL_INTERNAL' ? clip(payload.text, 150000) : publicEmailText(message, env);
  const html = message.kind === 'EMAIL_INTERNAL' ? String(payload.html || '').slice(0, 150000) : '';
  try {
    const response = await jsonFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + providerKey, 'Content-Type': 'application/json', 'Idempotency-Key': clip(message.idempotency_key, 200), 'User-Agent': 'MagnetOS/2.0' },
      body: JSON.stringify({ from, to: recipients, subject, html: html || undefined, text: text || (html ? undefined : ' ') }),
    });
    if (!response.response.ok) return { outcome: 'FAILED', provider: 'resend', providerStatus: 'rejected', errorCategory: 'PROVIDER_REJECTED', safeContext: { httpStatus: response.response.status } };
    return { outcome: 'ACCEPTED', provider: 'resend', providerMessageId: clip(response.payload && response.payload.id, 160), providerStatus: 'accepted' };
  } catch (error) {
    return { outcome: 'FAILED', provider: 'resend', providerStatus: 'unavailable', errorCategory: 'PROVIDER_UNAVAILABLE' };
  }
}

async function deliverWhatsApp(message, env) {
  const provider = clip(env.WHATSAPP_PROVIDER, 40).toLowerCase();
  const token = String(env.WHATSAPP_ACCESS_TOKEN || '');
  const phoneId = clip(env.WHATSAPP_PHONE_NUMBER_ID, 120);
  const recipient = configuredRecipient(message, env).replace(/\D/g, '');
  if (provider !== 'meta' || !token || !phoneId || recipient.length < 8) {
    return { outcome: 'FAILED', provider: provider || 'whatsapp', providerStatus: 'not_configured', errorCategory: 'CONFIGURATION_MISSING' };
  }
  const text = publicEmailText(message, env).slice(0, 4000);
  try {
    const version = clip(env.WHATSAPP_GRAPH_VERSION || 'v23.0', 20);
    const response = await jsonFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, type: 'text', text: { preview_url: false, body: text } }),
    });
    if (!response.response.ok) return { outcome: 'FAILED', provider: 'meta-whatsapp', providerStatus: 'rejected', errorCategory: 'PROVIDER_REJECTED', safeContext: { httpStatus: response.response.status } };
    const providerMessageId = response.payload && response.payload.messages && response.payload.messages[0] && response.payload.messages[0].id;
    return { outcome: 'ACCEPTED', provider: 'meta-whatsapp', providerMessageId: clip(providerMessageId, 160), providerStatus: 'accepted' };
  } catch (error) {
    return { outcome: 'FAILED', provider: 'meta-whatsapp', providerStatus: 'unavailable', errorCategory: 'PROVIDER_UNAVAILABLE' };
  }
}

async function finishMessage(config, message, workerId, result) {
  const finished = await rpc(config, 'finish_outbox_message', {
    p_message_id: message.id,
    p_worker_id: workerId,
    p_outcome: result.outcome,
    p_provider: result.provider,
    p_provider_message_id: result.providerMessageId || null,
    p_provider_status: result.providerStatus || null,
    p_error_category: result.errorCategory || null,
    p_safe_context: result.safeContext || {},
  });
  if (!finished.response.ok) throw new Error('outbox_finish_failed');
  return finished.payload;
}

async function processClaimed(config, message, workerId, env) {
  const result = message.kind === 'WHATSAPP_PUBLIC_INTAKE'
    ? await deliverWhatsApp(message, env)
    : await deliverEmail(message, env);
  return finishMessage(config, message, workerId, result);
}

async function claimMessages(config, workerId, limit, messageId) {
  const claimed = await rpc(config, 'claim_outbox_messages', {
    p_worker_id: workerId, p_limit: limit, p_message_id: messageId || null,
  });
  if (!claimed.response.ok) throw new Error('outbox_claim_failed');
  return Array.isArray(claimed.payload) ? claimed.payload : [];
}

async function processOutbox(config, env, options = {}) {
  const workerId = 'worker-' + crypto.randomUUID();
  const messages = await claimMessages(config, workerId, options.limit || 10, options.messageId || null);
  const results = [];
  for (const message of messages) {
    try { results.push(await processClaimed(config, message, workerId, env)); }
    catch (error) { results.push({ ok: false, id: message.id, status: 'PROCESSING', error: 'PROCESSING_INTERRUPTED' }); }
  }
  return results;
}

function statusLabel(value) {
  const normalized = String(value || '').toUpperCase();
  return ({ PENDING: 'Queued', PROCESSING: 'Processing', ACCEPTED: 'Accepted', DELIVERED: 'Delivered', FAILED: 'Failed', SUPPRESSED: 'Suppressed', CANCELLED: 'Cancelled' })[normalized] || 'Unknown';
}

async function handleOutbox(request, env = process.env) {
  const method = String(request.method || '').toUpperCase();
  const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
  const origin = String(headers.origin || '');
  const responseBase = responseHeaders(origin, env);
  const originAllowed = !!(normalOrigin(origin) && allowedOrigins(env).has(normalOrigin(origin)));
  const workerSecret = String(env.OUTBOX_WORKER_SECRET || env.CRON_SECRET || '');
  const suppliedWorkerSecret = String(headers['x-outbox-secret'] || headers['x-magnet-secret'] || '').trim();
  const trustedWorker = !!(workerSecret && suppliedWorkerSecret === workerSecret);
  const token = bearerToken(headers);
  const config = serverConfig(env);
  const reply = (status, body) => ({ status, headers: responseBase, body });

  if (method === 'OPTIONS') return reply(originAllowed ? 200 : 403, originAllowed ? {} : { error: 'origin_not_allowed' });
  if (!config) return reply(503, { error: 'service_not_configured' });
  if (origin && !originAllowed) return reply(403, { error: 'origin_not_allowed' });

  const query = request.query || {};
  let body = request.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (error) { return reply(400, { error: 'invalid_json' }); }
  }

  if (method === 'GET') {
    if (!token && !trustedWorker) return reply(401, { error: 'authenticated_session_required' });
    if (query.health !== undefined || !query.id) {
      if (token) {
        const context = await rpc(config, 'current_identity_context', {}, token);
        if (!context.response.ok || !context.payload || context.payload.ok !== true) return reply(401, { error: 'authenticated_session_required' });
      }
      return reply(200, {
        ok: true,
        emailConfigured: !!(env.RESEND_API_KEY && env.FROM_EMAIL),
        whatsappConfigured: !!(env.WHATSAPP_PROVIDER === 'meta' && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
        workerConfigured: !!workerSecret,
      });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(query.id))) return reply(400, { error: 'invalid_message_id' });
    const status = await rpc(config, 'get_outbox_delivery_status', { p_message_id: query.id }, token);
    if (!status.response.ok || !status.payload || status.payload.ok !== true) return reply(status.response.status === 401 ? 401 : 404, { error: 'not_found' });
    return reply(200, { ...status.payload, status: statusLabel(status.payload.status) });
  }

  if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const action = clip(body.action || 'enqueue-email', 40);

  if (action === 'drain') {
    if (!trustedWorker) return reply(401, { error: 'worker_secret_required' });
    const results = await processOutbox(config, env, { limit: Math.max(1, Math.min(Number(body.limit) || 10, 25)) });
    return reply(200, { ok: true, processed: results.length, results: results.map((result) => ({ id: result.id, status: statusLabel(result.status), error: result.error || null })) });
  }

  if (!token) return reply(401, { error: 'authenticated_session_required' });

  if (action === 'retry') {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(body.id))) return reply(400, { error: 'invalid_message_id' });
    const retry = await rpc(config, 'retry_outbox_message', { p_message_id: body.id }, token);
    if (!retry.response.ok || !retry.payload || retry.payload.ok !== true) return reply(retry.response.status === 403 ? 403 : 404, { error: 'retry_not_allowed' });
    const processed = await processOutbox(config, env, { limit: 1, messageId: body.id });
    const result = processed[0] || retry.payload;
    return reply(200, { ...result, status: statusLabel(result.status) });
  }

  if (action !== 'enqueue-email') return reply(400, { error: 'invalid_action' });
  const email = validEmailPayload(body);
  if (!email) return reply(400, { error: 'invalid_email_payload' });
  const queued = await rpc(config, 'enqueue_email_message', {
    p_organization_id: email.organizationId,
    p_purpose: email.purpose,
    p_recipients: email.recipients,
    p_subject: email.subject,
    p_html: email.html,
    p_text: email.text,
    p_idempotency_key: email.idempotencyKey,
    p_request_hash: email.requestHash,
  }, token);
  if (!queued.response.ok || !queued.payload || queued.payload.ok !== true) {
    const error = clip(queued.payload && queued.payload.message, 100);
    return reply(queued.response.status === 401 ? 401 : queued.response.status === 403 ? 403 : 400, { error: error || 'email_enqueue_failed' });
  }
  const processed = await processOutbox(config, env, { limit: 1, messageId: queued.payload.id });
  const result = processed[0] || queued.payload;
  return reply(['ACCEPTED','DELIVERED'].includes(result.status) ? 200 : 202, {
    ok: true,
    id: queued.payload.id,
    correlationId: queued.payload.correlationId,
    status: statusLabel(result.status),
    error: result.lastErrorCategory || result.error || null,
    queued: !['ACCEPTED','DELIVERED'].includes(result.status),
  });
}

module.exports = { handleOutbox, processOutbox, _test: { allowedOrigins, validEmailPayload, statusLabel } };
