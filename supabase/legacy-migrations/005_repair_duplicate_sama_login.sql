-- Magnet OS migration 005 — merge the resurrected duplicate Sama login.
--
-- Root cause: an old browser pushed a previously deleted local account back to
-- `_accounts`. Both rows then owned the same email, so login nondeterministically
-- returned Content Creator while the Users screen showed the Sales row.
--
-- Safety:
--   * archives BOTH original rows in records_backup_001 before changing anything
--   * keeps the stable Sales account id used by historical CRM activity
--   * copies the password hash from the account successfully used on 2026-08-10
--   * is idempotent; re-running it does not delete or duplicate anything

do $$
declare
  old_id       constant text := 'acct-usr-mqz62yofbhpt';
  canonical_id constant text := 'acct-usr-73932fa3-3793-460e-a6f7-09a9d12acad9';
  employee_id  constant text := 'emp-9bb05572-e7d0-4d45-80d8-83794ae1aad9';
  old_data jsonb;
begin
  if not exists (select 1 from public.records where id=canonical_id and coll='_accounts') then
    raise exception 'Canonical Sama Sales account is missing; repair aborted';
  end if;

  select data into old_data from public.records where id=old_id and coll='_accounts';

  if old_data is not null then
    insert into public.records_backup_001 (id, coll, data, updated_at)
    select 'repair-005-'||r.id, '_accounts_repair_archive', r.data, now()
    from public.records r
    where r.id in (old_id,canonical_id)
      and not exists (
        select 1 from public.records_backup_001 b where b.id='repair-005-'||r.id
      );

    update public.records
    set data = data || jsonb_build_object(
      'passwordHash', old_data->'passwordHash',
      'username', old_data->'username',
      'lastLogin', old_data->'lastLogin',
      'isDefaultPassword', coalesce(old_data->'isDefaultPassword','true'::jsonb),
      'role', 'Sales',
      'employeeId', employee_id,
      'access', '{}'::jsonb,
      'status', 'Active'
    )
    where id=canonical_id and coll='_accounts';

    delete from public.records where id=old_id and coll='_accounts';
  end if;

  update public.records
  set data = data || jsonb_build_object(
    'userId', replace(canonical_id,'acct-',''),
    'email', 'samaangaf@gmail.com',
    'loginEmail', 'samaangaf@gmail.com',
    'appRole', 'Sales',
    'role', 'Sales',
    'accountStatus', 'Active'
  )
  where id=employee_id and coll='employees';

  if not exists (select 1 from public.migration_audit where migration='005_repair_duplicate_sama_login') then
    insert into public.migration_audit(migration,note)
    values ('005_repair_duplicate_sama_login',
      'Archived two duplicate login rows, kept usr-73932... as Sales, preserved the in-use password, linked emp-9bb055... and removed resurrected usr-mqz62...');
  end if;
end $$;
