-- Magnet OS migration 007 — link Shahd's existing login to her employee profile.
-- Her account was active and unique, but the stable employeeId/userId relation was
-- empty. Archive both originals, then repair both sides without changing the login
-- email, username, or password.

begin;

do $$
declare
  account_row_id constant text := 'acct-usr-4e98c9de-d996-4a07-86e1-8b8b8a01621c';
  employee_row_id constant text := 'emp-85ff53eb-fd06-4aca-9bac-9166a6b37960';
begin
  if not exists (select 1 from public.records where id=account_row_id and coll='_accounts')
     or not exists (select 1 from public.records where id=employee_row_id and coll='employees') then
    raise exception 'Shahd account/employee source is missing; transaction aborted';
  end if;

  insert into public.records_backup_001(id,coll,data,updated_at)
  select 'repair-007-'||r.id, '_account_link_repair_archive', r.data, now()
  from public.records r
  where r.id in (account_row_id,employee_row_id)
    and not exists (
      select 1 from public.records_backup_001 b where b.id='repair-007-'||r.id
    );

  update public.records
  set data=data || jsonb_build_object(
    'employeeId',employee_row_id,
    'role','Account Manager',
    'status','Active',
    'access','{}'::jsonb
  )
  where id=account_row_id and coll='_accounts';

  update public.records
  set data=data || jsonb_build_object(
    'userId',replace(account_row_id,'acct-',''),
    'email','shahdehab1730@gmail.com',
    'loginEmail','shahdehab1730@gmail.com',
    'appRole','Account Manager',
    'role','Account Manager',
    'accountStatus','Active'
  )
  where id=employee_row_id and coll='employees';

  delete from public.records
  where id='rl-4263b7db02732e2ddc7fb8d16966b5fb' and coll='_ratelimit';

  insert into public.migration_audit(migration,note)
  select '007_link_shahd_login',
    'Archived and linked Shahd account usr-4e98... to employee emp-85ff..., aligned Account Manager role, and cleared the latest failed-login counter.'
  where not exists (
    select 1 from public.migration_audit where migration='007_link_shahd_login'
  );
end $$;

commit;
