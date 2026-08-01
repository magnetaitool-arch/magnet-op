// Magnet OS — email sender (Vercel Serverless Function -> Resend)
// The live site runs on Vercel, so the email path must be a Vercel function
// (the old netlify/functions/send-email.js does NOT run on Vercel). The app
// POSTs { to, subject, html?, text? } here; this function holds the secret API
// key server-side (never in the browser) and calls Resend's REST API.
//
// SETUP (one time): Vercel -> Project -> Settings -> Environment Variables:
//   RESEND_API_KEY = your_resend_key
//   FROM_EMAIL     = Magnet OS <onboarding@resend.dev>   (or your verified sender)
// Then redeploy. Until you verify a domain in Resend, use onboarding@resend.dev.

// Anti-abuse: only the current Magnet deployment (or an explicit allow-list)
// may use this endpoint. In particular, do not accept every *.vercel.app host:
// that would let an unrelated Vercel project use this function as an email relay.
// Server-to-server callers must provide EMAIL_SHARED_SECRET.
function normalOrigin(value) {
  try { return new URL(String(value || '')).origin; } catch (e) { return ''; }
}

function allowedOrigins() {
  const extra = (process.env.EMAIL_ALLOWED_ORIGINS || '').split(',').map((s) => normalOrigin(s.trim())).filter(Boolean);
  const deployment = process.env.VERCEL_URL ? normalOrigin('https://' + process.env.VERCEL_URL) : '';
  return Array.from(new Set(['https://magnet-op.vercel.app', deployment].concat(extra).filter(Boolean)));
}

function allowedOrigin(origin) {
  const normalized = normalOrigin(origin);
  return !!normalized && allowedOrigins().includes(normalized);
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
  return { recipients, subject, html, text };
}

function send(res, status, obj, origin) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  // Do not reflect a disallowed Origin. The browser then blocks that caller even
  // before the explicit 403 below is exposed to its JavaScript.
  if (allowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', normalOrigin(origin));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-magnet-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const origin = req.headers && req.headers.origin;
  if (req.method === 'OPTIONS') return allowedOrigin(origin)
    ? send(res, 200, {}, origin)
    : send(res, 403, { error: 'Forbidden origin' }, origin);
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, origin);

  // Origin allowlist OR shared-secret gate (blocks cross-site open-relay abuse).
  const secret = process.env.EMAIL_SHARED_SECRET;
  const hasSecret = !!(secret && req.headers && req.headers['x-magnet-secret'] === secret);
  if (!hasSecret && !allowedOrigin(origin)) return send(res, 403, { error: 'Forbidden origin' }, origin);

  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>';
  if (!KEY) return send(res, 500, { error: 'RESEND_API_KEY is not set in Vercel environment variables.' }, origin);

  // Vercel auto-parses JSON bodies, but be defensive for string bodies too.
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { return send(res, 400, { error: 'Invalid JSON body' }, origin); } }

  const message = validPayload(b);
  if (!message) return send(res, 400, { error: 'Invalid email payload' }, origin);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: message.recipients,
        subject: message.subject,
        html: message.html || undefined,
        text: message.text || (message.html ? undefined : ' '),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, r.status, { error: (data && (data.message || data.name)) || ('Email provider rejected the request (' + r.status + ')') }, origin);
    return send(res, 200, { ok: true, id: data && data.id }, origin);
  } catch (e) {
    return send(res, 500, { error: 'Email service is unavailable.' }, origin);
  }
};
