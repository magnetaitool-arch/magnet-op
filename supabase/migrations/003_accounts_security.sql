-- ============================================================================
-- Magnet OS migration 003 — accounts hardening helpers. ADDITIVE, non-destructive.
-- ----------------------------------------------------------------------------
-- Depends on 002 (which blocks anon from _accounts). This migration adds
-- server-side conveniences that NEVER expose password hashes:
--   * a sanitized, hash-free view of accounts for service-role reporting
--   * a guard trigger that stamps account rows with a server timestamp
-- It does NOT change how the app or the Edge Function work; both keep using the
-- records table directly. Safe to run before or after the app update.
--
-- ROLLBACK (non-destructive):
--   drop view if exists public.accounts_safe;
--   drop trigger if exists records_accounts_stamp on public.records;
--   drop function if exists public.stamp_account_row();
-- ============================================================================

-- Sanitized view: account roster WITHOUT passwordHash / verifyToken. Only the
-- service_role (or a future authenticated admin) should query this; anon RLS on
-- the base table still blocks anon regardless.
create or replace view public.accounts_safe as
select
  id,
  (data - 'passwordHash' - 'verifyToken') as data,
  updated_at
from public.records
where coll = '_accounts';

comment on view public.accounts_safe is
  'Hash-free account roster (passwordHash/verifyToken stripped). Never expose password hashes to clients.';

-- Guard trigger: whenever an _accounts row is written, record a server-side
-- timestamp inside data.serverUpdatedAt (tamper-evident vs the client-supplied
-- updatedAt). Purely additive — does not reject or alter the payload otherwise.
create or replace function public.stamp_account_row()
returns trigger language plpgsql as $$
begin
  if new.coll = '_accounts' then
    new.data = jsonb_set(coalesce(new.data,'{}'::jsonb), '{serverUpdatedAt}', to_jsonb(now()::text), true);
  end if;
  return new;
end;
$$;

drop trigger if exists records_accounts_stamp on public.records;
create trigger records_accounts_stamp
  before insert or update on public.records
  for each row execute function public.stamp_account_row();

insert into public.migration_audit (migration, note)
values ('003_accounts_security', 'added accounts_safe view (hash-free) + server-side account stamp trigger');

-- ---------- verification ----------
-- select count(*) from public.accounts_safe;                 -- roster size, no hashes
-- select data ? 'passwordHash' as leaks_hash from public.accounts_safe limit 1;  -- must be false
