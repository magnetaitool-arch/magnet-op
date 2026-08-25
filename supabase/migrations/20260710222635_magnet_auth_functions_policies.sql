-- Add linkage columns to the existing profiles table (safe/additive)
alter table public.profiles add column if not exists client_id   text;
alter table public.profiles add column if not exists employee_id text;

-- Helper functions (role is app_role enum -> cast to text for comparisons)
create or replace function public.auth_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role::text from public.profiles where id = auth.uid()), 'anon');
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.auth_role() in ('Owner','Admin');
$$;
create or replace function public.is_finance()
returns boolean language sql stable security definer set search_path = public as $$
  select public.auth_role() in ('Owner','Admin','Finance','Accountant');
$$;
create or replace function public.my_client_id()
returns text language sql stable security definer set search_path = public as $$
  select client_id from public.profiles where id = auth.uid();
$$;
create or replace function public.is_finance_coll(c text)
returns boolean language sql immutable as $$
  select c in ('invoices','payments','expenses','fixedCosts','partners',
               'partnerSettlements','profitability','employeePayments');
$$;
create or replace function public.is_public_insert_coll(c text)
returns boolean language sql immutable as $$
  select c in ('leads','briefs');
$$;

-- Profiles RLS (app does not read profiles yet, safe to enable)
alter table public.profiles enable row level security;
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using ( id = auth.uid() or public.is_admin() );
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for all using ( public.is_admin() ) with check ( public.is_admin() );

-- records policies — created INERT (RLS NOT enabled on records in this phase)
drop policy if exists records_select on public.records;
create policy records_select on public.records for select using (
  public.is_finance()
  or ( auth.uid() is not null and not public.is_finance_coll(coll)
       and ( public.auth_role() <> 'Client'
             or ( coll in ('projects','deliverables','invoices','files','revisions',
                           'contracts','reports','clientAssets')
                  and (data->>'clientId') = public.my_client_id() ) ) )
);
drop policy if exists records_insert on public.records;
create policy records_insert on public.records for insert with check (
  ( auth.uid() is not null and ( not public.is_finance_coll(coll) or public.is_finance() ) )
  or ( auth.uid() is null and public.is_public_insert_coll(coll) )
);
drop policy if exists records_update on public.records;
create policy records_update on public.records for update using (
  auth.uid() is not null and ( not public.is_finance_coll(coll) or public.is_finance() )
) with check (
  auth.uid() is not null and ( not public.is_finance_coll(coll) or public.is_finance() )
);
drop policy if exists records_delete on public.records;
create policy records_delete on public.records for delete using (
  public.is_admin()
  or ( auth.uid() is not null and not public.is_finance_coll(coll)
       and coll not in ('invoices','payments') )
);

-- Public-form RPCs (SECURITY DEFINER)
create or replace function public.get_campaign_by_slug(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select data from public.records where coll='campaigns' and data->>'slug'=p_slug limit 1;
$$;
create or replace function public.get_brief_by_token(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select data from public.records where coll='briefs' and data->>'token'=p_token limit 1;
$$;
create or replace function public.submit_brief(p_token text, p_answers jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.records set data = data || p_answers || jsonb_build_object('status','submitted')
   where coll='briefs' and data->>'token'=p_token;
end; $$;
create or replace function public.verify_account(p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare hit int;
begin
  update public.records set data = data || jsonb_build_object('verified',true,'verifyToken',null)
   where coll='_accounts' and data->>'verifyToken'=p_token;
  get diagnostics hit = row_count; return hit > 0;
end; $$;
grant execute on function public.get_campaign_by_slug(text) to anon, authenticated;
grant execute on function public.get_brief_by_token(text) to anon, authenticated;
grant execute on function public.submit_brief(text, jsonb) to anon, authenticated;
grant execute on function public.verify_account(text) to anon, authenticated;;
