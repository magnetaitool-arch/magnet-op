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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '{}' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>';
  if (!KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'RESEND_API_KEY is not set in Netlify environment variables.' }) };

  let b = {};
  try { b = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  if (!b.to || !b.subject) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"to" and "subject" are required' }) };

  try {
    const res = await fetch('https://api.resend.com/emails', {
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: (data && (data.message || data.name)) || ('Resend error ' + res.status), detail: data }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: data && data.id }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
