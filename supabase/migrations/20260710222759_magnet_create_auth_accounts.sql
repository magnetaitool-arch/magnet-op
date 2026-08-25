create extension if not exists pgcrypto;
do $$
declare
  r record;
  uid uuid;
  emp_id text;
  tmp_pw text := 'Magnet@2026';
begin
  for r in
    with kept(acct_id, rls_role) as (
      values
        ('acct-usr-876ce5a1-6f07-4de7-b3ff-80df4583c09f','Designer'),
        ('acct-usr-c778ef46-e7ea-4414-908e-24208505a665','Designer'),
        ('acct-usr-9c517b52-c4b0-4dc5-be2b-251f7b29ea86','Content Creator'),
        ('acct-usr-7db9bbb1-850b-42e3-86a0-8781a37c6b4c','Content Creator'),
        ('acct-usr-c3911486-3fb4-49e8-ad9a-9d4386d0b67f','Owner'),
        ('acct-usr-mpyn0plle358','Owner'),
        ('acct-usr-96535a92-0982-4736-83b6-8b0f97cc2771','Manager'),
        ('acct-usr-mqz5rup3786b','Content Creator'),
        ('acct-usr-e5997e1f-073b-46ef-8688-06dcc4870e86','Content Creator'),
        ('acct-usr-d0c023c3-6db5-411e-88c4-fc5aa1af44e2','Content Creator'),
        ('acct-usr-5640c415-fcc7-477e-9dda-8a5ef4842ad9','Designer'),
        ('acct-usr-4e98c9de-d996-4a07-86e1-8b8b8a01621c','Account Manager'),
        ('acct-usr-73932fa3-3793-460e-a6f7-09a9d12acad9','Sales'),
        ('acct-usr-owner','Owner')
    )
    select k.rls_role,
           lower(trim(a.data->>'email')) as email,
           a.data->>'username' as username,
           a.data->>'fullName' as full_name
    from kept k join public.records a on a.id = k.acct_id and a.coll='_accounts'
  loop
    -- reuse existing auth user if the email already exists
    select id into uid from auth.users where lower(email)=r.email limit 1;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
        r.email, crypt(tmp_pw, gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        '', '', '', ''
      );
      insert into auth.identities (
        provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
      ) values (
        uid::text, uid,
        jsonb_build_object('sub', uid::text, 'email', r.email, 'email_verified', true),
        'email', now(), now(), now()
      );
    end if;

    -- link to an employee record if one matches by email
    select e.id into emp_id from public.records e
      where e.coll='employees'
        and lower(coalesce(e.data->>'loginEmail', e.data->>'email','')) = r.email
      limit 1;

    -- upsert profile (single source for RLS role)
    insert into public.profiles (id, full_name, username, email, role, status, employee_id)
    values (uid, r.full_name, r.username, r.email, r.rls_role::app_role, 'Active'::user_status, emp_id)
    on conflict (id) do update
      set username=excluded.username, email=excluded.email, role=excluded.role,
          full_name=excluded.full_name, employee_id=coalesce(excluded.employee_id, public.profiles.employee_id);
  end loop;
end $$;

select p.username, p.email, p.role, case when p.employee_id is not null then 'linked' else '-' end as emp
from public.profiles p order by p.role, p.username;;
