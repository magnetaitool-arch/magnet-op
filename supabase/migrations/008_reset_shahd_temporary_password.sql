-- Magnet OS migration 008 — emergency server-side password reset for Shahd.
-- The public recovery endpoint returned enumeration-safe {ok:true}, but email
-- delivery was not confirmed and the password remained unchanged. Archive the
-- current account row, set one temporary PBKDF2 password, and require a change.

begin;

insert into public.records_backup_001(id,coll,data,updated_at)
select 'repair-008-'||r.id, '_account_password_reset_archive', r.data, now()
from public.records r
where r.id='acct-usr-4e98c9de-d996-4a07-86e1-8b8b8a01621c' and r.coll='_accounts'
  and not exists (
    select 1 from public.records_backup_001 b where b.id='repair-008-'||r.id
  );

update public.records
set data=data || jsonb_build_object(
  'passwordHash','pbkdf2$150000$YUw0RxAnJXCIjC6ug2Zb/w==$tNOa5EXc3/jGlkf34yhTItG+jPBFay1BK8tSekwWcR0=',
  'isDefaultPassword',true,
  'status','Active'
)
where id='acct-usr-4e98c9de-d996-4a07-86e1-8b8b8a01621c' and coll='_accounts';

insert into public.migration_audit(migration,note)
select '008_reset_shahd_temporary_password',
  'Archived Shahd account before an emergency server-side temporary password reset; user must change password after login.'
where not exists (
  select 1 from public.migration_audit where migration='008_reset_shahd_temporary_password'
);

commit;
