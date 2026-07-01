// Magnet OS — accounts/auth Edge Function (service-role). Keeps password hashes
// server-side so the browser never reads them. Custom HMAC session tokens gate
// account writes. verify_jwt is off; auth is handled in-body.
//
// DEPLOY (needs owner approval — touches live auth for the whole team):
//   supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd
// Optional env (Supabase → Edge Functions → accounts → Secrets): RESEND_API_KEY, FROM_EMAIL
const URL = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = KEY; // HMAC key material (server-only)
const REST = URL.replace(/\/$/,'') + '/rest/v1/records';
const RESEND = Deno.env.get('RESEND_API_KEY') || '';
const FROM = Deno.env.get('FROM_EMAIL') || 'Magnet OS <onboarding@resend.dev>';
const EMAIL_ENDPOINT = 'https://magnet-op.vercel.app/api/send-email';

const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization,apikey,content-type', 'Access-Control-Allow-Methods':'POST,OPTIONS', 'Content-Type':'application/json' };
const json = (obj:unknown, status=200)=> new Response(JSON.stringify(obj), { status, headers: CORS });
const nowISO = ()=> new Date().toISOString();
const enc = new TextEncoder();

function b64(bytes:Uint8Array){ let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
function fromB64(str:string){ const bin=atob(str); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
function b64url(str:string){ return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64url(str:string){ str=str.replace(/-/g,'+').replace(/_/g,'/'); while(str.length%4) str+='='; return atob(str); }
function hex(buf:ArrayBuffer){ return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join(''); }

async function sha256hex(pw:string){ const h=await crypto.subtle.digest('SHA-256', enc.encode(pw)); return 'sha256:'+hex(h); }
function legacyFallback(pw:string){ let h=0; for(let i=0;i<pw.length;i++){ h=((h<<5)-h+pw.charCodeAt(i))|0; } return 'fallback:'+(h>>>0).toString(16); }
async function pbkdf2Bits(pw:string, salt:Uint8Array, iters:number){ const key=await crypto.subtle.importKey('raw', enc.encode(pw), {name:'PBKDF2'}, false, ['deriveBits']); return await crypto.subtle.deriveBits({name:'PBKDF2', salt, iterations:iters, hash:'SHA-256'}, key, 256); }
async function makePbkdf2(pw:string){ const salt=crypto.getRandomValues(new Uint8Array(16)); const bits=await pbkdf2Bits(pw, salt, 150000); return 'pbkdf2$150000$'+b64(salt)+'$'+b64(new Uint8Array(bits)); }
async function verifyPw(pw:string, hash:string){ hash=String(hash||''); if(hash.indexOf('pbkdf2$')===0){ try{ const p=hash.split('$'); const bits=await pbkdf2Bits(pw, fromB64(p[2]), parseInt(p[1],10)||150000); return b64(new Uint8Array(bits))===p[3]; }catch{ return false; } } if(hash.indexOf('sha256:')===0) return (await sha256hex(pw))===hash; return legacyFallback(pw)===hash; }

async function hmac(msg:string){ const key=await crypto.subtle.importKey('raw', enc.encode(SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); const sig=await crypto.subtle.sign('HMAC', key, enc.encode(msg)); return b64url(String.fromCharCode(...new Uint8Array(sig))); }
async function makeToken(u:any){ const payload=b64url(JSON.stringify({uid:u.id, role:u.role||'', exp:Date.now()+30*86400000})); return payload+'.'+await hmac(payload); }
async function readToken(token:string){ try{ const [payload,sig]=String(token||'').split('.'); if(!payload||!sig) return null; if((await hmac(payload))!==sig) return null; const p=JSON.parse(unb64url(payload)); if(!p.exp||p.exp<Date.now()) return null; return p; }catch{ return null; } }
function isAdmin(role:string){ const r=String(role||''); return ['Owner','Admin','Manager','Project Manager','HR'].includes(r); }

async function dbAll(){ const r=await fetch(REST+'?coll=eq._accounts&select=id,data', { headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }); if(!r.ok) throw new Error('db read '+r.status); return await r.json(); }
async function dbUpsert(rows:any[]){ const r=await fetch(REST+'?on_conflict=id', { method:'POST', headers:{ apikey:KEY, Authorization:'Bearer '+KEY, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates,return=minimal' }, body:JSON.stringify(rows) }); if(!r.ok) throw new Error('db write '+r.status+' '+await r.text()); }
async function dbDelete(id:string){ const r=await fetch(REST+'?id=eq.'+encodeURIComponent(id), { method:'DELETE', headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }); if(!r.ok) throw new Error('db del '+r.status); }
const sanitize = (u:any)=>{ const c={...u}; delete c.passwordHash; delete c.verifyToken; return c; };

// ---- email helper (was previously called but never defined -> `forgot` crashed).
// Sends via Resend directly when RESEND_API_KEY is set, otherwise POSTs to the
// app's own /api/send-email Vercel function. Returns true only on a real success
// so `forgot` never rotates a password when the mail could not be delivered.
async function sendMail(to:string, subject:string, text:string):Promise<boolean>{
  if(!to) return false;
  try{
    if(RESEND){
      const r=await fetch('https://api.resend.com/emails',{
        method:'POST',
        headers:{ Authorization:'Bearer '+RESEND, 'Content-Type':'application/json' },
        body:JSON.stringify({ from:FROM, to:[to], subject, text }),
      });
      return r.ok;
    }
    // No key on the function itself — fall back to the deployed email endpoint.
    const r=await fetch(EMAIL_ENDPOINT,{
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ to, subject, text }),
    });
    return r.ok;
  }catch{ return false; }
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:CORS});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body:any={}; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const action=body.action;
  try{
    const rows=await dbAll();
    const accounts=rows.map((r:any)=>({ rowId:r.id, u:r.data||{} }));
    const findByLogin=(id:string)=>{ id=(id||'').trim().toLowerCase(); return accounts.find((a:any)=> (a.u.email||'').toLowerCase()===id || (a.u.username||'').toLowerCase()===id); };
    const findById=(uid:string)=> accounts.find((a:any)=> a.u.id===uid);

    if(action==='login'){
      const rec=findByLogin(body.identifier);
      if(!rec) return json({ ok:false, reason:'invalid' });
      if(rec.u.status && rec.u.status!=='Active') return json({ ok:false, reason:'inactive' });
      if(!(await verifyPw(body.password||'', rec.u.passwordHash||''))) return json({ ok:false, reason:'invalid' });
      const u={...rec.u, lastLogin:nowISO()};
      if(!String(u.passwordHash||'').startsWith('pbkdf2$')){ try{ u.passwordHash=await makePbkdf2(body.password); }catch{} }
      await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]);
      return json({ ok:true, user:sanitize(u), token:await makeToken(u) });
    }
    if(action==='list'){
      const p=await readToken(body.token); if(!p) return json({error:'unauthorized'},401);
      return json({ ok:true, users: accounts.map((a:any)=>sanitize(a.u)) });
    }
    if(action==='save'){
      const p=await readToken(body.token);
      const incoming = Array.isArray(body.users)? body.users : (body.user? [body.user] : []);
      if(!incoming.length) return json({error:'no users'},400);
      const bootstrap = accounts.length===0;
      if(!bootstrap && !p) return json({error:'unauthorized'},401);
      const admin = bootstrap || isAdmin(p.role);
      const out:any[]=[];
      for(const nu of incoming){ if(!nu||!nu.id) continue;
        if(!admin && nu.id!==p.uid) continue; // non-admins may only write their own account
        const ex=findById(nu.id); const merged={...(ex?ex.u:{}), ...nu};
        if(!merged.passwordHash && ex) merged.passwordHash=ex.u.passwordHash;
        if(!admin && ex){ merged.role=ex.u.role; merged.status=ex.u.status; merged.passwordHash=ex.u.passwordHash; merged.access=ex.u.access; } // no self privilege/password escalation
        out.push({ id:'acct-'+nu.id, coll:'_accounts', data:merged });
      }
      if(out.length) await dbUpsert(out);
      return json({ ok:true, saved:out.length });
    }
    if(action==='delete'){
      const p=await readToken(body.token); if(!p||!isAdmin(p.role)) return json({error:'unauthorized'},401);
      if(!body.id) return json({error:'no id'},400);
      await dbDelete('acct-'+body.id);
      return json({ ok:true });
    }
    if(action==='verify'){
      const tok=body.verifyToken; if(!tok) return json({error:'no token'},400);
      const rec=accounts.find((a:any)=> a.u.verifyToken===tok);
      if(!rec) return json({ ok:false });
      const u={...rec.u, verified:true}; delete u.verifyToken;
      await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]);
      return json({ ok:true, user:sanitize(u) });
    }
    if(action==='changepw'){
      const p=await readToken(body.token); if(!p) return json({error:'unauthorized'},401);
      const targetId = body.id && isAdmin(p.role) ? body.id : p.uid;
      const rec=findById(targetId); if(!rec) return json({ ok:false });
      if(targetId===p.uid && body.currentPassword!=null){ if(!(await verifyPw(body.currentPassword, rec.u.passwordHash||''))) return json({ ok:false, reason:'bad-current' }); }
      // SECURITY: the server ALWAYS hashes. A client-supplied `newHash` is ignored
      // so no caller can inject an arbitrary stored hash for an account.
      if(!body.newPassword || String(body.newPassword).length<6) return json({error:'weak password'},400);
      const newHash = await makePbkdf2(String(body.newPassword));
      const u={...rec.u, passwordHash:newHash, isDefaultPassword:false};
      await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]);
      return json({ ok:true });
    }
    if(action==='forgot'){
      const rec=findByLogin(body.identifier);
      if(rec && rec.u.email){
        const temp=hex(crypto.getRandomValues(new Uint8Array(5)).buffer);
        const sent=await sendMail(rec.u.email, 'Your temporary password — Magnet OS', 'Your temporary password is: '+temp+'\nPlease change it after signing in (Profile).');
        if(sent){ const u={...rec.u, passwordHash:await makePbkdf2(temp), isDefaultPassword:true}; await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]); }
      }
      return json({ ok:true });
    }
    return json({error:'unknown action'},400);
  }catch(e){
    // Log the real error to the function logs, but return a generic message so
    // internal details (SQL, stack traces) are never exposed to the browser.
    console.error('accounts function error:', (e as any)?.message||e);
    return json({error:'server error'},500);
  }
});
