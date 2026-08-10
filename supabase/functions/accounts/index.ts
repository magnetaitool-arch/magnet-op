// Magnet OS — accounts/auth Edge Function (service-role), v10.
// v7+ makes account administration confirmable and recoverable: separate login and
// recovery throttles, explicit lock status/unlock, live-role authorization (so an old
// token cannot keep admin rights), duplicate-login prevention, and last-owner guards.
const URL = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = KEY; // HMAC key material (server-only)
const REST = URL.replace(/\/$/,'') + '/rest/v1/records';
const AUTHB = URL.replace(/\/$/,'') + '/auth/v1';
const RESEND = Deno.env.get('RESEND_API_KEY') || '';
const FROM = Deno.env.get('FROM_EMAIL') || 'Magnet OS <onboarding@resend.dev>';
const EMAIL_ENDPOINT = 'https://magnet-op.vercel.app/api/send-email';
const EMAIL_SHARED_SECRET = Deno.env.get('EMAIL_SHARED_SECRET') || '';
const INITIAL_OWNER_SETUP_SECRET = Deno.env.get('INITIAL_OWNER_SETUP_SECRET') || '';

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
function isAdmin(role:string){ const r=String(role||''); return ['Owner','Admin','Manager'].includes(r); }

async function dbAll(){ const r=await fetch(REST+'?coll=eq._accounts&select=id,data', { headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }); if(!r.ok) throw new Error('db read '+r.status); return await r.json(); }
async function dbUpsert(rows:any[]){ const r=await fetch(REST+'?on_conflict=id', { method:'POST', headers:{ apikey:KEY, Authorization:'Bearer '+KEY, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates,return=minimal' }, body:JSON.stringify(rows) }); if(!r.ok) throw new Error('db write '+r.status+' '+await r.text()); }
async function dbDelete(id:string){ const r=await fetch(REST+'?id=eq.'+encodeURIComponent(id), { method:'DELETE', headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }); if(!r.ok) throw new Error('db del '+r.status); }
const sanitize = (u:any)=>{ const c={...u}; delete c.passwordHash; delete c.verifyToken; return c; };

// ---- AUTH_V2 (additive) helpers: Supabase Auth Admin API + password grant ----
async function adminFindUserByEmail(email:string){
  try{
    const r=await fetch(AUTHB+'/admin/users?per_page=200', { headers:{ apikey:KEY, Authorization:'Bearer '+KEY } });
    if(!r.ok) return null;
    const d=await r.json(); const list=(d && (d.users||d)) || [];
    return (Array.isArray(list)?list:[]).find((u:any)=> String(u.email||'').toLowerCase()===email.toLowerCase()) || null;
  }catch{ return null; }
}
async function adminSetPassword(uid:string, password:string){
  try{ const r=await fetch(AUTHB+'/admin/users/'+uid, { method:'PUT', headers:{ apikey:KEY, Authorization:'Bearer '+KEY, 'Content-Type':'application/json' }, body:JSON.stringify({ password, email_confirm:true }) }); return r.ok; }catch{ return false; }
}
async function adminCreateUser(email:string, password:string){
  try{ const r=await fetch(AUTHB+'/admin/users', { method:'POST', headers:{ apikey:KEY, Authorization:'Bearer '+KEY, 'Content-Type':'application/json' }, body:JSON.stringify({ email, password, email_confirm:true }) }); if(!r.ok) return null; return await r.json(); }catch{ return null; }
}
async function passwordGrant(email:string, password:string){
  try{ const r=await fetch(AUTHB+'/token?grant_type=password', { method:'POST', headers:{ apikey:KEY, 'Content-Type':'application/json' }, body:JSON.stringify({ email, password }) }); if(!r.ok) return null; return await r.json(); }catch{ return null; }
}

async function sendMail(to:string, subject:string, text:string):Promise<boolean>{
  if(!to) return false;
  try{
    if(RESEND){
      const r=await fetch('https://api.resend.com/emails',{ method:'POST', headers:{ Authorization:'Bearer '+RESEND, 'Content-Type':'application/json' }, body:JSON.stringify({ from:FROM, to:[to], subject, text }) });
      return r.ok;
    }
    // The Vercel endpoint rejects origin-less server traffic unless it carries
    // the shared secret. Configure the same EMAIL_SHARED_SECRET in both hosts.
    const headers:Record<string,string>={ 'Content-Type':'application/json' };
    if(EMAIL_SHARED_SECRET) headers['x-magnet-secret']=EMAIL_SHARED_SECRET;
    const r=await fetch(EMAIL_ENDPOINT,{ method:'POST', headers, body:JSON.stringify({ to, subject, text }) });
    return r.ok;
  }catch{ return false; }
}

const RL_LOGIN_WINDOW_MS = 15*60*1000;
const RL_LOGIN_MAX = 10;
const RL_FORGOT_WINDOW_MS = 60*60*1000;
const RL_FORGOT_MAX = 4;
async function rlKey(action:string, id:string){ const h=await crypto.subtle.digest('SHA-256', enc.encode(action+':'+String(id||'').trim().toLowerCase())); return 'rl-'+hex(h).slice(0,32); }
async function rlState(action:string, id:string, windowMs:number, max:number):Promise<{blocked:boolean,retryAfterSeconds:number,count:number}>{
  try{
    const key=await rlKey(action,id); const r=await fetch(REST+'?id=eq.'+encodeURIComponent(key)+'&select=data', { headers:{ apikey:KEY, Authorization:'Bearer '+KEY } });
    if(!r.ok) return {blocked:false,retryAfterSeconds:0,count:0};
    const rows=await r.json(); const d=(rows[0]&&rows[0].data)||null;
    if(!d) return {blocked:false,retryAfterSeconds:0,count:0};
    const age=Date.now()-(Number(d.windowStart)||0);
    if(age>windowMs){ await fetch(REST+'?id=eq.'+encodeURIComponent(key), { method:'DELETE', headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }).catch(()=>{}); return {blocked:false,retryAfterSeconds:0,count:0}; }
    return {blocked:(Number(d.count)||0)>=max,retryAfterSeconds:Math.max(1,Math.ceil((windowMs-age)/1000)),count:Number(d.count)||0};
  }catch{ return {blocked:false,retryAfterSeconds:0,count:0}; }
}
async function rlBump(action:string, id:string, windowMs:number){ try{ const key=await rlKey(action,id); const r=await fetch(REST+'?id=eq.'+encodeURIComponent(key)+'&select=data', { headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }); let d:any={count:0, windowStart:Date.now()}; if(r.ok){ const rows=await r.json(); const ex=rows[0]&&rows[0].data; if(ex && Date.now()-(ex.windowStart||0)<=windowMs) d={count:ex.count||0, windowStart:ex.windowStart}; } d.count=(d.count||0)+1; await dbUpsert([{ id:key, coll:'_ratelimit', data:d }]); }catch{} }
async function rlClear(action:string, id:string){ try{ const key=await rlKey(action,id); await fetch(REST+'?id=eq.'+encodeURIComponent(key), { method:'DELETE', headers:{ apikey:KEY, Authorization:'Bearer '+KEY } }); }catch{} }

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:CORS});
  if(req.method!=='POST') return json({error:'POST only'},405);
  let body:any={}; try{ body=await req.json(); }catch{ return json({error:'bad json'},400); }
  const action=body.action;
  try{
    if(action==='login'||action==='authv2'){
      const state=await rlState('login',body.identifier,RL_LOGIN_WINDOW_MS,RL_LOGIN_MAX);
      if(state.blocked) return json({ ok:false, reason:'rate-limited', retryAfterSeconds:state.retryAfterSeconds },429);
    }
    if(action==='forgot'){
      const state=await rlState('forgot',body.identifier,RL_FORGOT_WINDOW_MS,RL_FORGOT_MAX);
      if(state.blocked) return json({ ok:false, reason:'rate-limited', retryAfterSeconds:state.retryAfterSeconds },429);
    }
    const rows=await dbAll();
    const accounts=rows.map((r:any)=>({ rowId:r.id, u:r.data||{} }));
    const findByLogin=(id:string)=>{ id=(id||'').trim().toLowerCase(); return accounts.find((a:any)=> (a.u.email||'').toLowerCase()===id || (a.u.username||'').toLowerCase()===id); };
    const findById=(uid:string)=> accounts.find((a:any)=> a.u.id===uid);
    const liveActor=async(token:string)=>{ const p=await readToken(token); if(!p) return null; const rec=findById(p.uid); return rec&&(!rec.u.status||rec.u.status==='Active')?rec.u:null; };

    // Public startup discovery reveals only whether first-owner setup is required.
    // It never returns the account roster, identities, roles, or password metadata.
    if(action==='health') return json({ok:true,service:'accounts',version:10,database:'reachable',needsSetup:accounts.length===0});

    // Return the CURRENT server-side identity for an existing session. The UI must
    // not keep trusting the role/access snapshot cached at login forever: an Owner
    // may promote, downgrade, disable, or repair a linked employee while that person
    // still has the app open. `liveActor` deliberately resolves the token uid back
    // through `_accounts`, so stale role claims inside an older token never win.
    if(action==='me'){
      const actor=await liveActor(body.token);
      if(!actor) return json({error:'unauthorized'},401);
      return json({ok:true,user:sanitize(actor)});
    }

    if(action==='login'){
      const rec=findByLogin(body.identifier);
      if(!rec){ await rlBump('login', body.identifier, RL_LOGIN_WINDOW_MS); return json({ ok:false, reason:'invalid' }); }
      if(rec.u.status && rec.u.status!=='Active') return json({ ok:false, reason:'inactive' });
      if(!(await verifyPw(body.password||'', rec.u.passwordHash||''))){ await rlBump('login', body.identifier, RL_LOGIN_WINDOW_MS); return json({ ok:false, reason:'invalid' }); }
      await rlClear('login', body.identifier);
      const u={...rec.u, lastLogin:nowISO()};
      if(!String(u.passwordHash||'').startsWith('pbkdf2$')){ try{ u.passwordHash=await makePbkdf2(body.password); }catch{} }
      await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]);
      return json({ ok:true, user:sanitize(u), token:await makeToken(u) });
    }

    // ---- NEW additive action: JWT layer. Returns a real Supabase session in addition
    // to (not instead of) the legacy flow. Verifies the SAME legacy password, then syncs
    // the Supabase Auth password to it and issues a session. Never modifies _accounts. ----
    if(action==='authv2'){
      const rec=findByLogin(body.identifier);
      if(!rec){ await rlBump('login', body.identifier, RL_LOGIN_WINDOW_MS); return json({ ok:false, reason:'invalid' }); }
      if(rec.u.status && rec.u.status!=='Active') return json({ ok:false, reason:'inactive' });
      if(!(await verifyPw(body.password||'', rec.u.passwordHash||''))){ await rlBump('login', body.identifier, RL_LOGIN_WINDOW_MS); return json({ ok:false, reason:'invalid' }); }
      const email=String(rec.u.email||'').toLowerCase().trim();
      if(!email || email.indexOf('@')<1) return json({ ok:false, reason:'no-email' });
      let au=await adminFindUserByEmail(email);
      if(au && au.id){ await adminSetPassword(au.id, body.password); }
      else { au=await adminCreateUser(email, body.password); }
      const session=await passwordGrant(email, body.password);
      if(!session || !session.access_token) return json({ ok:false, reason:'session-failed' });
      await rlClear('login', body.identifier);
      return json({ ok:true, session, user:sanitize(rec.u) });
    }

    if(action==='list'){ const actor=await liveActor(body.token); if(!actor||!isAdmin(actor.role)) return json({error:'unauthorized'},401); return json({ ok:true, users: accounts.map((a:any)=>sanitize(a.u)) }); }
    if(action==='save'){
      const p=await readToken(body.token); const actor=p?await liveActor(body.token):null;
      const incoming = Array.isArray(body.users)? body.users : (body.user? [body.user] : []);
      if(!incoming.length) return json({error:'no users'},400);
      const bootstrap = accounts.length===0;
      // A public browser can reach this function, so an empty accounts table must
      // not grant the first anonymous visitor an Owner account. The deployment
      // owner supplies this one-time secret through the initial setup screen.
      if(bootstrap && (!INITIAL_OWNER_SETUP_SECRET || body.bootstrapSecret!==INITIAL_OWNER_SETUP_SECRET)) return json({error:'setup-required'},403);
      if(!bootstrap && !actor) return json({error:'accounts-exist'},401);
      const admin = bootstrap || !!(actor&&isAdmin(actor.role));
      const out:any[]=[];
      for(const nu of incoming){ if(!nu||!nu.id) continue;
        if(!admin && nu.id!==p.uid) continue;
        const ex=findById(nu.id); const merged={...(ex?ex.u:{}), ...nu};
        if(!merged.passwordHash && ex) merged.passwordHash=ex.u.passwordHash;
        if(!ex && !/^pbkdf2\$\d+\$[^$]+\$[^$]+$/.test(String(merged.passwordHash||''))) return json({error:'invalid-password-hash'},400);
        if(!admin && ex){ merged.role=ex.u.role; merged.status=ex.u.status; merged.passwordHash=ex.u.passwordHash; merged.access=ex.u.access; }
        out.push({ id:'acct-'+nu.id, coll:'_accounts', data:merged });
      }
      if(!out.length) return json({error:'unauthorized'},401);
      const current=new Map(accounts.map((a:any)=>[a.u.id,{...a.u}]));
      const future=new Map(current); out.forEach((r:any)=>future.set(r.data.id,r.data));
      // Block NEW identity collisions, but do not let a historical duplicate make
      // every unrelated role/status repair impossible. Old duplicates are handled
      // by an audited one-time merge; unchanged emails/usernames may still receive
      // security and role updates in the meantime.
      for(const row of out){
        const u:any=row.data, ex:any=current.get(u.id), uid=String(u.id||'');
        const email=String(u.email||'').trim().toLowerCase(), oldEmail=String((ex&&ex.email)||'').trim().toLowerCase();
        const username=String(u.username||'').trim().toLowerCase(), oldUsername=String((ex&&ex.username)||'').trim().toLowerCase();
        if(email && (!ex||email!==oldEmail) && [...future.values()].some((x:any)=>String(x.id||'')!==uid&&String(x.email||'').trim().toLowerCase()===email)) return json({error:'duplicate-email'},409);
        if(username && (!ex||username!==oldUsername) && [...future.values()].some((x:any)=>String(x.id||'')!==uid&&String(x.username||'').trim().toLowerCase()===username)) return json({error:'duplicate-username'},409);
      }
      if(![...future.values()].some((u:any)=>u.role==='Owner'&&(!u.status||u.status==='Active'))) return json({error:'last-owner'},409);
      if(out.length) await dbUpsert(out);
      return json({ ok:true, saved:out.length });
    }
    if(action==='delete'){ const actor=await liveActor(body.token); if(!actor||!isAdmin(actor.role)) return json({error:'unauthorized'},401); if(!body.id) return json({error:'no id'},400); const target=findById(body.id); if(target&&target.u.role==='Owner'&&accounts.filter((a:any)=>a.u.role==='Owner'&&(!a.u.status||a.u.status==='Active')).length<=1) return json({error:'last-owner'},409); await dbDelete('acct-'+body.id); return json({ ok:true }); }
    if(action==='verify'){ const tok=body.verifyToken; if(!tok) return json({error:'no token'},400); const rec=accounts.find((a:any)=> a.u.verifyToken===tok); if(!rec) return json({ ok:false }); const u={...rec.u, verified:true}; delete u.verifyToken; await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]); return json({ ok:true, user:sanitize(u) }); }
    if(action==='changepw'){
      const p=await readToken(body.token); const actor=p?await liveActor(body.token):null; if(!p||!actor) return json({error:'unauthorized'},401);
      const targetId = body.id && isAdmin(actor.role) ? body.id : p.uid;
      const rec=findById(targetId); if(!rec) return json({ ok:false });
      if(targetId===p.uid && body.currentPassword!=null){ if(!(await verifyPw(body.currentPassword, rec.u.passwordHash||''))) return json({ ok:false, reason:'bad-current' }); }
      let newHash:string|null = null;
      if(body.newPassword){
        const next=String(body.newPassword);
        if(next.length<10 || !/[a-z]/.test(next) || !/[A-Z]/.test(next) || !/\d/.test(next)) return json({error:'weak password'},400);
        newHash = await makePbkdf2(next);
      }
      else if(typeof body.newHash==='string' && /^pbkdf2\$\d+\$/.test(body.newHash)){ newHash = body.newHash; }
      if(!newHash) return json({error:'no valid new password'},400);
      const u={...rec.u, passwordHash:newHash, isDefaultPassword:!!body.temporary};
      await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]);
      await rlClear('login',rec.u.email||''); await rlClear('login',rec.u.username||'');
      return json({ ok:true });
    }
    if(action==='unlock'){
      const actor=await liveActor(body.token); if(!actor||!isAdmin(actor.role)) return json({error:'unauthorized'},401);
      const rec=body.id?findById(body.id):findByLogin(body.identifier||''); if(!rec) return json({ok:true});
      await rlClear('login',rec.u.email||''); await rlClear('login',rec.u.username||'');
      await rlClear('forgot',rec.u.email||''); await rlClear('forgot',rec.u.username||'');
      return json({ok:true});
    }
    if(action==='forgot'){
      await rlBump('forgot', body.identifier, RL_FORGOT_WINDOW_MS);
      const rec=findByLogin(body.identifier);
      if(rec && rec.u.email){ const temp='M'+hex(crypto.getRandomValues(new Uint8Array(6)).buffer)+'a1'; const sent=await sendMail(rec.u.email, 'Your temporary password — Magnet OS', 'Your temporary password is: '+temp+'\nPlease change it after signing in (Profile).'); if(sent){ const u={...rec.u, passwordHash:await makePbkdf2(temp), isDefaultPassword:true}; await dbUpsert([{ id:rec.rowId, coll:'_accounts', data:u }]); await rlClear('login',rec.u.email||''); await rlClear('login',rec.u.username||''); } }
      return json({ ok:true });
    }
    return json({error:'unknown action'},400);
  }catch(e){ console.error('accounts function error:', (e as any)?.message||e); return json({error:'server error'},500); }
});
