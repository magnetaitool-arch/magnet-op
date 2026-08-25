-- MAGNET OS V2 / M1.5 — attach canonical profile provisioning to Auth.

begin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.migration_audit (migration, note)
select
  '20260825120129_attach_auth_profile_trigger',
  'Attached the fail-closed V2 profile provisioning trigger to auth.users; new identities now receive a pending profile but no organization membership or trusted role.'
where not exists (
  select 1 from public.migration_audit where migration = '20260825120129_attach_auth_profile_trigger'
);

commit;
