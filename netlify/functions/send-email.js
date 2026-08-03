// Magnet OS — email sender (Netlify Function -> Resend)
// The app's browser code POSTs { to, subject, html?, text? } here. This function
// holds the secret API key server-side (never exposed to the browser) and calls
// Resend's REST API. Node 18+ on Netlify provides a global fetch, so there are no
// npm dependencies to install — this works with drag-and-drop deploys.
//
// SETUP (one time):
//   1) Create a free account at https://resend.com and copy an API key.
//   2) In Netlify: Site settings -> Environment variables, add:
//        RESEND_API_KEY = your_resend_key
//        FROM_EMAIL     = Magnet OS <onboarding@resend.dev>   (or your verified sender)
//   3) Redeploy the site.
//
// Until a domain is verified in Resend, you can send using the shared
// "onboarding@resend.dev" sender (good for testing). For production, verify your
// own domain in Resend and set FROM_EMAIL to an address on it.

// Keep the legacy Netlify endpoint as strict as the Vercel endpoint. A wildcard
// CORS policy here turns a configured Resend key into an open relay.
function normalOrigin(value) {
  try { return new URL(String(value || '')).origin; } catch (e) { return ''; }
}

function allowedOrigins() {
  const extra = (process.env.EMAIL_ALLOWED_ORIGINS || '').split(',').map((s) => normalOrigin(s.trim())).filter(Boolean);
  const netlifyOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL].map(normalOrigin).filter(Boolean);
  return Array.from(new Set(['https://magnet-op.vercel.app'].concat(netlifyOrigins, extra)));
}

function allowedOrigin(origin) {
  const normalized = normalOrigin(origin);
  return !!normalized && allowedOrigins().includes(normalized);
}

function headers(origin) {
  const out = {
    'Access-Control-Allow-Headers': 'Content-Type, x-magnet-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  if (allowedOrigin(origin)) out['Access-Control-Allow-Origin'] = normalOrigin(origin);
  return out;
}

function response(statusCode, origin, body) {
  return { statusCode, headers: headers(origin), body: JSON.stringify(body) };
}

function validPayload(body) {
  const recipients = (Array.isArray(body && body.to) ? body.to : [body && body.to])
    .map((value) => String(value || '').trim()).filter(Boolean);
  const subject = String((body && body.subject) || '').trim();
  const html = body && body.html == null ? '' : String((body && body.html) || '');
  const text = body && body.text == null ? '' : String((body && body.text) || '');
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!recipients.length || recipients.length > 10 || recipients.some((value) => !email.test(value))) return null;
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) return null;
  if (!html && !text) return null;
  if (html.length > 100000 || text.length > 100000) return null;
  const idempotencyKey = String((body && body.idempotencyKey) || '').trim();
  if (idempotencyKey && (idempotencyKey.length > 256 || !/^[A-Za-z0-9_./:-]+$/.test(idempotencyKey))) return null;
  return { recipients, subject, html, text, idempotencyKey };
}

function validEmailId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

function senderInfo(from) {
  const match = String(from || '').match(/<([^>]+)>/) || [];
  const address = (match[1] || String(from || '')).trim();
  const domain = (address.split('@')[1] || '').toLowerCase();
  return { senderMode: domain === 'resend.dev' ? 'test' : 'custom', fromDomain: domain || null };
}

exports.handler = async (event) => {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  if (event.httpMethod === 'OPTIONS') return allowedOrigin(origin)
    ? response(200, origin, {})
    : response(403, origin, { error: 'Forbidden origin' });
  const secret = process.env.EMAIL_SHARED_SECRET;
  const suppliedSecret = event.headers && (event.headers['x-magnet-secret'] || event.headers['X-Magnet-Secret']);
  const hasSecret = !!(secret && suppliedSecret === secret);
  if (!hasSecret && !allowedOrigin(origin)) return response(403, origin, { error: 'Forbidden origin' });

  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>';
  if (!KEY) return response(500, origin, { error: 'RESEND_API_KEY is not set in Netlify environment variables.' });

  if (event.httpMethod === 'GET') {
    const rawId = event.queryStringParameters && event.queryStringParameters.id;
    const id = validEmailId(rawId);
    if (!rawId) return response(200, origin, Object.assign({ ok: true, configured: true }, senderInfo(FROM)));
    if (!id) return response(400, origin, { error: 'Invalid email id' });
    try {
      const res = await fetch('https://api.resend.com/emails/' + encodeURIComponent(id), {
        headers: { Authorization: 'Bearer ' + KEY, 'User-Agent': 'MagnetOS/1.0' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return response(res.status, origin, { error: (data && (data.message || data.name)) || ('Email provider rejected the request (' + res.status + ')') });
      return response(200, origin, {
        ok: true, id: data.id || id, last_event: data.last_event || 'sent',
        to: data.to || [], created_at: data.created_at || null, subject: data.subject || '',
      });
    } catch (e) { return response(500, origin, { error: 'Email service is unavailable.' }); }
  }
  if (event.httpMethod !== 'POST') return response(405, origin, { error: 'Method not allowed' });

  let b = {};
  try { b = JSON.parse(event.body || '{}'); }
  catch (e) { return response(400, origin, { error: 'Invalid JSON body' }); }

  const message = validPayload(b);
  if (!message) return response(400, origin, { error: 'Invalid email payload' });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: Object.assign({ Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'User-Agent': 'MagnetOS/1.0' },
        message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      body: JSON.stringify({
        from: FROM,
        to: message.recipients,
        subject: message.subject,
        html: message.html || undefined,
        text: message.text || (message.html ? undefined : ' '),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return response(res.status, origin, { error: (data && (data.message || data.name)) || ('Email provider rejected the request (' + res.status + ')') });
    return response(200, origin, { ok: true, id: data && data.id });
  } catch (e) {
    return response(500, origin, { error: 'Email service is unavailable.' });
  }
};
