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

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>';
  if (!KEY) return send(res, 500, { error: 'RESEND_API_KEY is not set in Vercel environment variables.' });

  // Vercel auto-parses JSON bodies, but be defensive for string bodies too.
  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { return send(res, 400, { error: 'Invalid JSON body' }); } }

  if (!b.to || !b.subject) return send(res, 400, { error: '"to" and "subject" are required' });

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
    if (!r.ok) return send(res, r.status, { error: (data && (data.message || data.name)) || ('Resend error ' + r.status), detail: data });
    return send(res, 200, { ok: true, id: data && data.id });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
};
