'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');
// Official Svix signing contract: sign the original bytes, never parsed/re-encoded JSON.
function verifySignature(raw, headers, secret, now = Date.now()) {
  const id = String(headers['svix-id'] || '');
  const timestamp = String(headers['svix-timestamp'] || '');
  if (!Buffer.isBuffer(raw) || raw.length > 262144 || !/^whsec_[A-Za-z0-9+/=]+$/.test(secret || '') || !id || id.length > 200 || !/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(id + '.' + timestamp + '.').update(raw).digest();
  return String(headers['svix-signature'] || '').split(' ').slice(0, 10).some(signature => {
    if (!signature.startsWith('v1,')) return false;
    const supplied = Buffer.from(signature.slice(3), 'base64');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
async function handleWebhook(raw, headers, env = process.env) {
  if (!env.RESEND_WEBHOOK_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { status: 503, body: { error: 'webhook_not_configured' } };
  if (!verifySignature(raw, headers, env.RESEND_WEBHOOK_SECRET)) return { status: 401, body: { error: 'invalid_signature' } };
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
  const supported = ['email.sent','email.delivered','email.bounced','email.complained','email.failed','email.delivery_delayed'];
  if (!supported.includes(event.type)) return { status: 200, body: { ignored: true } };
  if (!/^[0-9a-f-]{36}$/i.test(event.data?.email_id || '') || !Number.isFinite(Date.parse(event.created_at))) return { status: 400, body: { error: 'invalid_event' } };
  try {
    const response = await fetch(env.SUPABASE_URL.replace(/\/$/,'') + '/rest/v1/rpc/apply_resend_event_v2', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({ p_event_id: headers['svix-id'], p_provider_id: event.data.email_id, p_event_type: event.type, p_occurred_at: event.created_at }),
    });
    return response.ok ? { status: 200, body: { ok: true } } : { status: 503, body: { error: 'event_persistence_failed' } };
  } catch { return { status: 503, body: { error: 'event_persistence_failed' } }; }
}
module.exports = { verifySignature, handleWebhook };
