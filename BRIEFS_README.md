# Client Brief Intake — Setup & Notes

A complete "Client Brief" flow: admin generates a brief link → sends it (Copy / WhatsApp)
→ client fills a branded bilingual (RTL) form → answers save to Supabase → the brief shows
back in the dashboard as **Submitted**, fully viewable.

## ⚠️ How this was built vs. the original spec
The spec assumed **Netlify functions + a separate `briefs` table**. The live app is deployed
on **Vercel** (static) and uses a single unified **`records`** table synced to the dashboard.
Building Netlify functions would NOT run on the Vercel deployment, so this was adapted to the
real, working stack:

| Spec | Built (works on your live site) |
|---|---|
| `briefs` table | `records` table, `coll:"briefs"` (auto-syncs to dashboard) |
| `create-brief.js` / `submit-brief.js` Netlify fns | Browser → Supabase REST (anon key) — same pattern as Campaigns/Verify |
| `brief.html` page | In-app public route `?brief=TOKEN` (like `?form=` / `?verify=`) |
| project ref `ksunojpdzunyqrxdmogd` | **`jdylrthffifbhyrrhuqd`** (your actual project, already wired) |

## ✅ Manual steps required
**None for the database** — the `records` table and its RLS policies (anon select/insert,
upsert) already exist and power the rest of the app. No SQL migration, no env vars, no redeploy
config. The publishable (anon) key is already embedded in the browser; the `service_role` key
is never used client-side.

### Optional hardening (if you want tighter RLS later)
The current `records` RLS lets anon read/upsert (this is the existing app design — the same way
leads, campaigns and accounts already work). The brief **token** is an unguessable random string,
so a brief is only reachable by someone holding its link. If you later want per-row scoping,
move create/submit behind a server function with `service_role` and expose read via a token RPC.

## How to use
1. Dashboard → **Sales → Client Briefs → New Brief** (optionally pre-fill name/company/type).
2. You get a **brief link** + **Copy** + **WhatsApp** buttons. Send it to the client.
3. Client opens the link (mobile, RTL, branded), fills the 9 sections, submits.
4. Status flows **pending → opened → submitted**. The submission appears in the Briefs table;
   **View** shows every answer, lets you save internal notes, and **Reopen** for the client.

## File uploads
Brand assets are collected as **links** (paste a Drive/Figma URL) — no Supabase Storage bucket
required. To switch to real uploads later, create a public `brief-uploads` bucket and swap the
"Brand assets" link field for a file input that uploads with the anon key.

## Public routes (no login)
- `…/?brief=TOKEN`  → client brief form
- `…/?form=SLUG`    → campaign lead form
- `…/?verify=TOKEN` → email verification
