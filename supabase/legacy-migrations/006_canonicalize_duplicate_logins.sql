-- Magnet OS migration 006 — canonicalize every historical duplicate login.
--
-- Old browsers once re-uploaded their complete cached account roster. That could
-- resurrect deleted rows and leave two or more accounts owning the same email or
-- username. Login then selected whichever row PostgREST returned first, sometimes
-- opening an old role or rejecting a password that belonged to another duplicate.
--
-- Safety:
--   * archives every affected original row before any delete/update
--   * preserves the password from the account most recently used successfully
--   * links the canonical account to the matching employee and App role
--   * adds partial unique indexes so this class of bug cannot return
--   * explicit ids only; unrelated accounts are never selected by a broad delete

begin;

create temporary table _repair_006_map (
  canonical_row_id text primary key,
  password_source_row_id text not null,
  employee_row_id text,
  login_email text not null,
  canonical_role text not null
) on commit drop;

insert into _repair_006_map values
  ('acct-usr-a2991fff-6766-4516-a4c1-241881ee9818','acct-usr-a2991fff-6766-4516-a4c1-241881ee9818','emp-e2d509a2-926b-4c93-872f-894240e3f6b9','aminalaa089@gmail.com','Graphic Designer'),
  ('acct-usr-69b3f61b-dbd8-4783-82fc-772abe48e87d','acct-usr-69b3f61b-dbd8-4783-82fc-772abe48e87d','emp-3d30b0c0-7423-4ab2-b8ea-9c73f9bd6cf6','farahfaroha103@gmail.com','Content Creator'),
  ('acct-usr-mqz6n891fg4a','acct-usr-mqz6n891fg4a','emp-79702c7e-de9e-4761-ae86-57363d805853','himaahodeb2@gmail.com','Graphic Designer'),
  ('acct-usr-mpyn0plle358','acct-usr-mpyn0plle358','emp-5113b046-0780-4c96-b409-3fd67d012dea','muhammedtarek1234@gmail.com','Manager'),
  ('acct-usr-mqz71g1dhjlz','acct-usr-mqz71g1dhjlz','emp-b22c26b6-8888-4801-bc12-fe8c635cfdfd','rework552@gmail.com','Content Creator'),
  ('acct-usr-96535a92-0982-4736-83b6-8b0f97cc2771','acct-usr-96535a92-0982-4736-83b6-8b0f97cc2771','emp-813a844a-c78a-429d-ba2e-eb7cc8b5a402','samahassan955@gmail.com','HR'),
  -- Keep the account that owns Yomna's valid email, but preserve the password from
  -- the duplicate she used most recently (the row whose "email" was not an email).
  ('acct-usr-7db9bbb1-850b-42e3-86a0-8781a37c6b4c','acct-usr-8f03a769-8d60-4ea4-a932-319c5c816844','emp-2ba78465-3535-40cf-8da4-7e7db55a1caf','yomna7794@gmail.com','Content Creator'),
  ('acct-usr-8c11abe1-e32a-45be-9e5a-2c51e62d4751','acct-usr-8c11abe1-e32a-45be-9e5a-2c51e62d4751',null,'youmnasobhyy65@gmail.com','Account Manager');

create temporary table _repair_006_drop (
  row_id text primary key,
  canonical_row_id text not null
) on commit drop;

insert into _repair_006_drop values
  ('acct-usr-876ce5a1-6f07-4de7-b3ff-80df4583c09f','acct-usr-a2991fff-6766-4516-a4c1-241881ee9818'),
  ('acct-usr-mqz6jp1kao0h','acct-usr-a2991fff-6766-4516-a4c1-241881ee9818'),
  ('acct-usr-e5997e1f-073b-46ef-8688-06dcc4870e86','acct-usr-69b3f61b-dbd8-4783-82fc-772abe48e87d'),
  ('acct-usr-5e2dde93-5fd1-4ce7-a240-6a91fc4e8727','acct-usr-mqz6n891fg4a'),
  ('acct-usr-ac231e17-7958-4213-8b93-e06d05bc990f','acct-usr-mqz6n891fg4a'),
  ('acct-usr-c778ef46-e7ea-4414-908e-24208505a665','acct-usr-mqz6n891fg4a'),
  ('acct-usr-0b9e6657-f9c8-414b-912a-34ec5ee8135e','acct-usr-mpyn0plle358'),
  ('acct-usr-9c517b52-c4b0-4dc5-be2b-251f7b29ea86','acct-usr-mqz71g1dhjlz'),
  ('acct-usr-mqz4qzi5drpy','acct-usr-96535a92-0982-4736-83b6-8b0f97cc2771'),
  ('acct-usr-ab9a77a3-8635-47a2-8eda-0fb2f47f6977','acct-usr-7db9bbb1-850b-42e3-86a0-8781a37c6b4c'),
  ('acct-usr-8f03a769-8d60-4ea4-a932-319c5c816844','acct-usr-7db9bbb1-850b-42e3-86a0-8781a37c6b4c'),
  ('acct-usr-mqz74ps57wwl','acct-usr-7db9bbb1-850b-42e3-86a0-8781a37c6b4c'),
  ('acct-usr-mqz79srjejs9','acct-usr-8c11abe1-e32a-45be-9e5a-2c51e62d4751');

do $$
begin
  if exists (
    select 1 from _repair_006_map m
    where not exists (select 1 from public.records r where r.id=m.canonical_row_id and r.coll='_accounts')
       or not exists (select 1 from public.records r where r.id=m.password_source_row_id and r.coll='_accounts')
  ) then
    raise exception 'Migration 006 source/canonical account missing; transaction aborted';
  end if;
end $$;

insert into public.records_backup_001 (id,coll,data,updated_at)
select 'repair-006-'||r.id, '_accounts_repair_archive',
       r.data || jsonb_build_object('repairCanonicalRowId',coalesce(d.canonical_row_id,m.canonical_row_id)), now()
from public.records r
left join _repair_006_drop d on d.row_id=r.id
left join _repair_006_map m on m.canonical_row_id=r.id
where r.coll='_accounts' and (d.row_id is not null or m.canonical_row_id is not null)
  and not exists (
    select 1 from public.records_backup_001 b where b.id='repair-006-'||r.id
  );

update public.records canonical
set data = canonical.data
  || jsonb_build_object(
    'passwordHash', source.data->'passwordHash',
    'username', source.data->'username',
    'lastLogin', source.data->'lastLogin',
    'isDefaultPassword', coalesce(source.data->'isDefaultPassword','true'::jsonb),
    'email', m.login_email,
    'role', m.canonical_role,
    'status', 'Active',
    'access', '{}'::jsonb
  )
  || case when m.employee_row_id is null then '{}'::jsonb
          else jsonb_build_object('employeeId',m.employee_row_id) end
from _repair_006_map m
join public.records source on source.id=m.password_source_row_id and source.coll='_accounts'
where canonical.id=m.canonical_row_id and canonical.coll='_accounts';

update public.records employee
set data = employee.data || jsonb_build_object(
  'userId', replace(m.canonical_row_id,'acct-',''),
  'email', m.login_email,
  'loginEmail', m.login_email,
  'appRole', m.canonical_role,
  'role', m.canonical_role,
  'accountStatus', 'Active'
)
from _repair_006_map m
where m.employee_row_id is not null
  and employee.id=m.employee_row_id and employee.coll='employees';

delete from public.records r
using _repair_006_drop d
where r.id=d.row_id and r.coll='_accounts';

create unique index if not exists records_accounts_email_unique
  on public.records ((lower(btrim(data->>'email'))))
  where coll='_accounts' and coalesce(btrim(data->>'email'),'')<>'';

create unique index if not exists records_accounts_username_unique
  on public.records ((lower(btrim(data->>'username'))))
  where coll='_accounts' and coalesce(btrim(data->>'username'),'')<>'';

insert into public.migration_audit(migration,note)
select '006_canonicalize_duplicate_logins',
  'Archived 21 source/canonical login rows, removed 13 historical duplicates, linked seven employee profiles, preserved each most recently used password, and added unique email/username indexes.'
where not exists (
  select 1 from public.migration_audit where migration='006_canonicalize_duplicate_logins'
);

commit;
