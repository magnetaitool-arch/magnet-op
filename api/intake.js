// Magnet OS — public website form intake (Vercel Serverless Function -> Supabase)
// ----------------------------------------------------------------------------
// The live site runs on Vercel, so the public forms must POST here (/api/intake).
// This is the Vercel twin of netlify/functions/intake.js (kept for Netlify).
//
// BOTH public website forms POST here instead of dumping to WhatsApp:
//   - Hiring form  -> { type:"candidate", ...fields, gameScore }
//   - Client form  -> { type:"lead", ...fields }
// It writes ONE row into the Supabase `records` table (same shape the browser app
// uses) plus a matching in-app notification, then optionally emails HR/Sales.
// The public forms hold NO database credentials — the key lives only in Vercel
// env here, and this endpoint will ONLY ever write `candidates` / `leads`.
//
// SETUP (Vercel -> Project -> Settings -> Environment Variables):
//   SUPABASE_URL   = https://jdylrthffifbhyrrhuqd.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = <service role key> (server-side only)
//   SUPABASE_ORGANIZATION_SLUG = magnet
//   (optional email notify, reuses Resend like api/send-email.js)
//   RESEND_API_KEY = <resend key>
//   FROM_EMAIL     = Magnet OS <onboarding@resend.dev>
//   HR_EMAIL       = hr@yourdomain.com      (candidate alerts)
//   SALES_EMAIL    = sales@yourdomain.com   (lead alerts)
//
// A service-role key is required. Public/anon database writes stay disabled.

// Only these collections may ever be written by this public endpoint.
const ALLOWED = { candidate: 'candidates', lead: 'leads' };

const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowISO = () => new Date().toISOString();
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

const CANDIDATE_FIELDS = ['fullName','age','mobile','otherPhones','email','area','maritalStatus','position','specialization','experience','availableFrom','currentSalary','expectedSalary','workplaces','courses','gameScore','cvLink','notes'];
const LEAD_FIELDS = ['name','company','email','phone','brand','source','serviceInterest','value','budget','notes','message','campaignId','campaignName'];
let organizationCache = null;

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined && body[f] !== null && body[f] !== '') out[f] = clip(body[f], 2000);
  return out;
}

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

  const URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(URL) || !KEY) return send(res, 503, { error: 'Service not configured' });
  if (Number(req.headers['content-length'] || 0) > 150000) return send(res, 413, { error: 'Payload too large' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { return send(res, 400, { error: 'Invalid JSON body' }); } }

  // Honeypot: bots fill hidden fields. Pretend success, write nothing.
  if (b.company_website || b.hp || b._gotcha) return send(res, 200, { ok: true, skipped: true });

  const coll = ALLOWED[b.type];
  if (!coll) return send(res, 400, { error: 'Invalid "type" (expected "candidate" or "lead")' });

  let rec, notif;
  if (b.type === 'candidate') {
    const f = pick(b, CANDIDATE_FIELDS);
    if (!f.fullName || !f.mobile || !f.email) return send(res, 400, { error: 'fullName, mobile and email are required' });
    rec = Object.assign({ id: uid('can'), source: 'Website', stage: 'New', rating: 0, appliedAt: nowISO(), createdAt: nowISO(), updatedAt: nowISO() }, f);
    notif = { id: uid('nt'), userId: null, role: 'HR', title: 'New job application',
      message: (f.fullName || 'A candidate') + ' applied for ' + (f.position || 'a role'),
      entityType: 'candidates', entityId: rec.id, read: false, createdAt: nowISO() };
  } else {
    const f = pick(b, LEAD_FIELDS);
    if (!f.name && !f.company) return send(res, 400, { error: 'name or company is required' });
    if (!f.email && !f.phone) return send(res, 400, { error: 'email or phone is required' });
    rec = Object.assign({ id: uid('lea'), name: f.name || f.company, source: 'Website', status: 'New Lead', brand: f.brand || 'Magnet', createdAt: nowISO(), updatedAt: nowISO() }, f);
    notif = { id: uid('nt'), userId: null, role: 'Sales', title: 'New website inquiry',
      message: (rec.name || 'A client') + (f.serviceInterest ? ' — ' + f.serviceInterest : ''),
      entityType: 'leads', entityId: rec.id, read: false, createdAt: nowISO() };
  }

  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
  try {
    if (!organizationCache) {
      const slug = String(process.env.SUPABASE_ORGANIZATION_SLUG || 'magnet').trim();
      const orgResponse = await fetch(URL + '/rest/v1/organizations?slug=eq.' + encodeURIComponent(slug) + '&status=eq.ACTIVE&deleted_at=is.null&select=id&limit=1', { headers });
      const organizations = orgResponse.ok ? await orgResponse.json() : [];
      organizationCache = organizations[0] && organizations[0].id;
      if (!organizationCache) return send(res, 503, { error: 'Organization unavailable' });
    }
    const rows = [
      { id: rec.id, coll, data: rec, organization_id: organizationCache },
      { id: notif.id, coll: 'notifications', data: notif, organization_id: organizationCache },
    ];
    const r = await fetch(URL + '/rest/v1/records?on_conflict=id', {
      method: 'POST', headers,
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      return send(res, 502, { error: 'Database write failed' });
    }
  } catch (e) {
    return send(res, 503, { error: 'Service unavailable' });
  }

  // Optional email alert (best-effort; never blocks the submission).
  try {
    const RK = process.env.RESEND_API_KEY;
    const to = b.type === 'candidate' ? process.env.HR_EMAIL : process.env.SALES_EMAIL;
    if (RK && to) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RK, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.FROM_EMAIL || 'Magnet OS <onboarding@resend.dev>', to: [to], subject: '[Magnet OS] ' + notif.title, text: notif.message + '\n\n' + JSON.stringify(rec, null, 2) }),
      });
    }
  } catch (e) { /* ignore email errors */ }

  return send(res, 200, { ok: true, id: rec.id });
};
