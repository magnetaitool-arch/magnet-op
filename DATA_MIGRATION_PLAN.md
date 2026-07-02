# Magnet OS — Data Migration Plan

Path from the current single-table model to normalized tables **without downtime and
without data loss**. Nothing here is destructive; normalization is staged and
backwards-compatible. **Do not run a destructive normalization now** — the app reads
`records` directly.

## Current model
One table `public.records { id, coll, data jsonb, updated_at }`, plus the additive
audit/sync columns from migration `004`. The browser app + all serverless functions
read/write this table. Strengths: dead simple, flexible. Weaknesses: no per-table
constraints, no per-collection RLS (all-or-nothing for anon), harder analytics.

## Guiding principles
1. **Dual-write / dual-read** during any transition — never a big-bang cutover.
2. Every normalized table is populated **from** `records` and kept in sync by a
   trigger, so the app keeps working against `records` unchanged.
3. Take a backup (`npm run backup:supabase`) before each step.
4. Each step is reversible by dropping the new table/view (never the `records` data).

## Order to split (highest value first)
1. **users/profiles** (`_accounts`) — smallest, most sensitive; unlocks Supabase Auth.
2. **clients** — central join target.
3. **projects** → **tasks** → **deliverables** (delivery chain).
4. **invoices** → **payments** (finance; enables strict finance RLS).
5. **employees** (HR; salary isolation).

## Backwards-compatible pattern (per table)

For each collection `X`:

```sql
-- 1. create the typed table (additive)
create table if not exists public.clients (
  id text primary key,
  name text, brand text, status text, owner_id text, assigned_to text,
  created_at timestamptz, updated_at timestamptz,
  data jsonb                       -- keep the raw payload for anything not yet typed
);

-- 2. backfill from records (idempotent upsert)
insert into public.clients (id, name, brand, status, owner_id, assigned_to, created_at, updated_at, data)
select id, data->>'name', data->>'brand', data->>'status',
       data->>'ownerId', data->>'assignedTo',
       (data->>'createdAt')::timestamptz, updated_at, data
from public.records where coll='clients'
on conflict (id) do update set
  name=excluded.name, brand=excluded.brand, status=excluded.status,
  owner_id=excluded.owner_id, assigned_to=excluded.assigned_to,
  updated_at=excluded.updated_at, data=excluded.data;

-- 3. keep them in sync BOTH ways with triggers while the app still uses records:
--    records (coll='clients') write -> upsert clients   (forward)
--    (optional) clients write        -> upsert records  (reverse, if a new UI writes clients)
```

The app continues to read/write `records`; the typed table trails it via the forward
trigger. Analytics/RLS can start using the typed table immediately.

## Cutover (only when a table is proven stable)
1. Point the relevant part of the data layer at the typed table (feature-flagged).
2. Keep the reverse trigger so `records` stays populated (rollback safety) for one
   release.
3. After a full release cycle with no drift, retire the `records`-side writes for
   that collection. `records` history is retained.

## Migrate without downtime — checklist
- [ ] Backup taken and validated.
- [ ] Typed table created + backfilled (idempotent).
- [ ] Forward sync trigger live; drift check passes
      (`select count(*) from records where coll='clients'` == `select count(*) from clients`).
- [ ] Read path switched behind a flag; verify in staging/preview.
- [ ] Monitor a full cycle; then narrow RLS on the typed table.

## Keeping backwards compatibility
- Never drop `records` or its rows.
- Typed tables keep a `data jsonb` column for un-typed fields, so no field is lost.
- Old app versions (and offline localStorage) keep working against `records`
  throughout, because `records` is never removed.

## Enables (post-normalization)
- **Stage B RLS**: per-table policies on `auth.uid()`/role so anon can't read
  finance/HR (see `SUPABASE_SECURITY_GUIDE.md`). This is the point at which
  "sensitive collections are not publicly readable" becomes fully enforced rather
  than partially (today only `_accounts` is blocked, safely).
