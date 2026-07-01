// Magnet OS — public website form intake (Netlify Function -> Supabase)
// ----------------------------------------------------------------------------
// BOTH public website forms POST here instead of dumping to WhatsApp:
//   - Hiring form    -> { type:"candidate", ...fields, gameScore }
//   - Client form    -> { type:"lead", ...fields }
// This function writes ONE row into the Supabase `records` table (same shape the
// browser app uses) and a matching in-app notification row, then optionally
// emails HR/Sales. The public forms hold NO database credentials — the key lives
// only in Netlify env here, and this function will ONLY ever write the
// whitelisted collections `candidates` / `leads`.
//
// NOTE: The live production project is jdylrthffifbhyrrhuqd (matches index.html and
// the accounts Edge Function). Older docs referenced ksunojpdzunyqrxdmogd — that is
// STALE; use jdylrthffifbhyrrhuqd everywhere.
//
// SETUP (Netlify -> Site settings -> Environment variables):
//   SUPABASE_URL   = https://jdylrthffifbhyrrhuqd.supabase.co
//   SUPABASE_KEY   = <service_role key>   (server-side only — NEVER in the browser)
//   (optional email notify, reuses Resend like send-email.js)
//   RESEND_API_KEY = <resend key>
//   FROM_EMAIL     = Magnet OS <onboarding@resend.dev>
//   HR_EMAIL       = hr@yourdomain.com      (candidate alerts)
//   SALES_EMAIL    = sales@yourdomain.com   (lead alerts)
//
// Node 18+ on Netlify provides a global fetch — no npm dependencies.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Only these collections may ever be written by this public endpoint.
const ALLOWED = {
  candidate: 'candidates',
  lead: 'leads',
};

const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowISO = () => new Date().toISOString();
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

// Whitelisted fields per form type (anything else in the payload is ignored).
const CANDIDATE_FIELDS = ['fullName','age','mobile','otherPhones','email','area','maritalStatus','position','specialization','experience','availableFrom','currentSalary','expectedSalary','workplaces','courses','gameScore','cvLink','notes'];
const LEAD_FIELDS = ['name','company','email','phone','brand','source','serviceInterest','value','budget','notes','message'];

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined && body[f] !== null && body[f] !== '') out[f] = clip(body[f], 2000);
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '{}' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Defaults make the form work with ZERO Netlify setup. The publishable key is
  // already public in the CRM, and this function only ever writes candidates/leads
  // (RLS allows anon insert), so embedding it here adds no extra exposure.
  // Optional: override with Netlify env vars (e.g. a service_role key) later.
  const URL = process.env.SUPABASE_URL || 'https://jdylrthffifbhyrrhuqd.supabase.co';
  const KEY = process.env.SUPABASE_KEY || 'sb_publishable_6Qe2KdPIZ13Ij2wvkS12rA_k2ytZQLz';

  let b = {};
  try { b = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // Honeypot: bots fill hidden fields. Pretend success, write nothing.
  if (b.company_website || b.hp || b._gotcha) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: true }) };

  const coll = ALLOWED[b.type];
  if (!coll) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid "type" (expected "candidate" or "lead")' }) };

  // Build the record (same shape cloudUpsert writes).
  let rec, notif;
  if (b.type === 'candidate') {
    const f = pick(b, CANDIDATE_FIELDS);
    if (!f.fullName || !f.mobile || !f.email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'fullName, mobile and email are required' }) };
    rec = Object.assign({
      id: uid('can'), source: 'Website', stage: 'New', rating: 0,
      appliedAt: nowISO(), createdAt: nowISO(), updatedAt: nowISO(),
    }, f);
    notif = { id: uid('nt'), userId: null, role: 'HR', title: 'New job application',
      message: (f.fullName || 'A candidate') + ' applied for ' + (f.position || 'a role'),
      entityType: 'candidates', entityId: rec.id, read: false, createdAt: nowISO() };
  } else {
    const f = pick(b, LEAD_FIELDS);
    if (!f.name && !f.company) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'name or company is required' }) };
    if (!f.email && !f.phone) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email or phone is required' }) };
    rec = Object.assign({
      id: uid('lea'), name: f.name || f.company, source: 'Website', status: 'New Lead', brand: f.brand || 'Magnet',
      createdAt: nowISO(), updatedAt: nowISO(),
    }, f);
    notif = { id: uid('nt'), userId: null, role: 'Sales', title: 'New website inquiry',
      message: (rec.name || 'A client') + (f.serviceInterest ? ' — ' + f.serviceInterest : ''),
      entityType: 'leads', entityId: rec.id, read: false, createdAt: nowISO() };
  }

  // Upsert record + notification in one request (PostgREST accepts an array).
  const headers = { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
  if (/^eyJ/.test(KEY)) headers.Authorization = 'Bearer ' + KEY; // JWT keys (service_role/anon) also go in Authorization
  try {
    const res = await fetch(URL.replace(/\/$/, '') + '/rest/v1/records?on_conflict=id', {
      method: 'POST', headers,
      body: JSON.stringify([{ id: rec.id, coll, data: rec }, { id: notif.id, coll: 'notifications', data: notif }]),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Database write failed (' + res.status + ')', detail }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }

  // Optional email alert (best-effort; never blocks the submission).
  try {
    const RK = process.env.RESEND_API_KEY;
    const to = b.type === 'candidate' ? process.env.HR_EMAIL : process.env.SALES_EMAIL;
    if (RK && to) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RK, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>',
          to: [to], subject: '[Magnet OS] ' + notif.title,
          text: notif.message + '\n\n' + JSON.stringify(rec, null, 2),
        }),
      });
    }
  } catch (e) { /* ignore email errors */ }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: rec.id }) };
};
