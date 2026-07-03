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

// Anti-abuse: only allow calls from the app's own origins (or a shared secret for
// server-to-server callers). Stops other websites' browsers from using your Resend
// key as an open relay. Same-origin browser calls from the app always pass. Extend
// with EMAIL_ALLOWED_ORIGINS (comma-separated) and/or EMAIL_SHARED_SECRET env vars.
function allowedOrigin(origin) {
  if (!origin) return true; // no Origin header = server-to-server (e.g. accounts fn); browser abuse always sends one
  const extra = (process.env.EMAIL_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const defaults = ['https://magnet-op.vercel.app'];
  try {
    const host = new URL(origin).host;
    if (/(^|\.)vercel\.app$/.test(host)) return true;      // production + preview deploys
    if (/^localhost(:\d+)?$/.test(host) || /^127\.0\.0\.1(:\d+)?$/.test(host)) return true;
  } catch (e) { return false; }
  return defaults.concat(extra).some((o) => o && origin === o);
}

function send(res, status, obj, origin) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  // Reflect only allowed origins (no wildcard) so browsers enforce the boundary too.
  res.setHeader('Access-Control-Allow-Origin', origin && allowedOrigin(origin) ? origin : 'https://magnet-op.vercel.app');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-magnet-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const origin = req.headers && req.headers.origin;
  if (req.method === 'OPTIONS') return send(res, 200, {}, origin);
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, origin);

  // Origin allowlist OR shared-secret gate (blocks cross-site open-relay abuse).
  const secret = process.env.EMAIL_SHARED_SECRET;
  const hasSecret = secret && req.headers && req.headers['x-magnet-secret'] === secret;
  if (!hasSecret && !allowedOrigin(origin)) return send(res, 403, { error: 'Forbidden origin' }, origin);

  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>';
  if (!KEY) return send(res, 500, { error: 'RESEND_API_KEY is not set in Vercel environment variables.' }, origin);

  // Vercel auto-parses JSON bodies, but be defensive for string bodies too.
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { return send(res, 400, { error: 'Invalid JSON body' }, origin); } }

  if (!b.to || !b.subject) return send(res, 400, { error: '"to" and "subject" are required' }, origin);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: Array.isArray(b.to) ? b.to : [b.to],
        subject: b.subject,
        html: b.html || undefined,
        text: b.text || (b.html ? undefined : ' '),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, r.status, { error: (data && (data.message || data.name)) || ('Resend error ' + r.status), detail: data }, origin);
    return send(res, 200, { ok: true, id: data && data.id }, origin);
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) }, origin);
  }
};
