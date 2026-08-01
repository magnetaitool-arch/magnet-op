# Magnet OS — Deployment (Vercel, corrected)

**Documented default target: Vercel** (the live site is `magnet-op.vercel.app`,
referenced by the accounts function and `api/send-email.js`). Netlify assets are
kept as optional legacy. The one production Supabase project is
**`jdylrthffifbhyrrhuqd`** — the older `ksunojpdzunyqrxdmogd` reference in some docs
was stale and has been corrected.

## What changed (Phase 5)
- Added **`api/intake.js`** — the Vercel serverless twin of the Netlify intake
  function. Public forms should POST to **`/api/intake`** on Vercel.
- `netlify/functions/intake.js` kept as legacy; its stale project-ref comment fixed.
- `vercel.json` already rewrites everything except `/api/*` and files to
  `index.html`, so `/api/intake` and `/api/send-email` work as functions with no
  extra config.

## Required environment variables (set in Vercel → Project → Settings → Env Vars)

| Var | Used by | Secret? |
|---|---|---|
| `RESEND_API_KEY` | `api/send-email.js`, `api/intake.js` (alerts) | **Yes** |
| `FROM_EMAIL` | same | No |
| `SUPABASE_URL` | `api/intake.js` (defaults to jdyl… if unset) | No |
| `SUPABASE_KEY` | `api/intake.js` — set to **service_role** for hardened writes | **Yes** |
| `HR_EMAIL`, `SALES_EMAIL` | intake alert recipients | No |
| `EMAIL_ALLOWED_ORIGINS` | optional comma-separated custom origins for `/api/send-email` | No |
| `EMAIL_SHARED_SECRET` | trusted server-to-server access to `/api/send-email` | **Yes** |

Edge Function `accounts` (Supabase → Edge Functions → accounts → Secrets):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`,
`EMAIL_SHARED_SECRET`, `INITIAL_OWNER_SETUP_SECRET`.

Full list + local `.env` for the tools: see **`.env.example`**.

## Vercel setup
1. Import the repo (framework preset: **Other** — the app is static + `/api`).
2. Set the env vars above. Redeploy.
3. `.vercelignore` excludes `tools`, `netlify`, SQL, and backups from the deploy.
   `magnetrun.html` IS deployed (it is the "Magnet Run" arcade game linked from the app).

## Supabase setup
1. `npm run backup:supabase` (keep the file).
2. Deploy the accounts function:
   `supabase functions deploy accounts --no-verify-jwt --project-ref jdylrthffifbhyrrhuqd`
   and set its secrets.
3. Apply migrations in order (`001`→`004`) — see `SUPABASE_SECURITY_GUIDE.md`.
4. Before the first owner is created, generate a long `INITIAL_OWNER_SETUP_SECRET`,
   set it on the **accounts Edge Function**, then enter it once in the in-app
   “Set up the owner account” screen. This prevents the first public visitor from
   claiming the Owner role.

## Email setup
1. Create a Resend account, copy an API key → `RESEND_API_KEY`.
2. Until you verify a domain, `FROM_EMAIL="Magnet OS <onboarding@resend.dev>"`.
3. For production, verify your domain in Resend and set `FROM_EMAIL` to an address on it.
4. Set the same long `EMAIL_SHARED_SECRET` on Vercel and the accounts Edge Function
   if the Edge Function should use `/api/send-email` as its fallback. Browser email
   calls are restricted to the exact Magnet deployment plus `EMAIL_ALLOWED_ORIGINS`.

## How to test

**Public intake form** (Vercel):
```bash
curl -s -X POST https://magnet-op.vercel.app/api/intake \
  -H 'Content-Type: application/json' \
  -d '{"type":"lead","name":"Test Co","email":"t@example.com","serviceInterest":"Branding"}'
# expect {"ok":true,"id":"lea-…"}; a leads row + a Sales notification appear in the app
```

**Accounts function**:
```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/accounts" -H "apikey: $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"action":"login","identifier":"nobody","password":"x"}'
# expect {"ok":false,"reason":"invalid"} (200) — proves it's deployed and responding
```

**Email API** (no secret leak): POST `{}` → `400` if live, `500` only if
`RESEND_API_KEY` unset. It never returns the key.

**Sync**: open the app on two devices, edit the same client; newest edit wins, no
data loss (see `SYNC_ENGINE_REPORT.md`). Or run `npm run check:config`.

## Acceptance criteria — status
- [x] Public intake works on Vercel via `/api/intake`.
- [x] Email API holds the key server-side; never exposes it (returns generic errors).
- [x] APIs return safe errors; missing env vars produce clear messages
      (`RESEND_API_KEY is not set…`).
- [x] Vercel default documented; Netlify kept as optional legacy.
