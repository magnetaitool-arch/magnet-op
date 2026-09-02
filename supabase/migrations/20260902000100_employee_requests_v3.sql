-- MAGNET OS V3: employee requests, policy-driven routing and audited effects.
--
-- Additive only. This module coexists with the legacy approvalRequests records
-- while the UI migrates to server-authoritative requests. Browser clients may
-- read only rows allowed by RLS and may mutate state only through the RPCs in
-- this migration. Sensitive complaint, medical and financial data is kept in a
-- separately protected table and never copied into notifications or audit data.

begin;

insert into public.capabilities(key,description) values
  ('requests.read','Read authorized employee requests'),
  ('requests.create','Create and manage own employee requests'),
  ('requests.approve','Decide employee requests assigned to the current user'),
  ('requests.policy.manage','Manage versioned employee request policies'),
  ('requests.confidential.read','Read confidential HR requests'),
  ('requests.finance.read','Read restricted financial request details'),
  ('requests.admin.read','Read equipment and administration request details')
on conflict (key) do update set description=excluded.description;

-- Request attachments need one visibility stricter than the generic HR bucket:
-- only the employee who owns the file and users with the dedicated confidential
-- request capability may read it.  Existing document visibility values and
-- behavior stay unchanged.
alter table public.document_files drop constraint if exists document_files_visibility_check;
alter table public.document_files add constraint document_files_visibility_check check (visibility in (
  'INTERNAL','CLIENT','HR_SENSITIVE','FINANCE_SENSITIVE','MANAGEMENT','CONFIDENTIAL_REQUEST'
));

create or replace function public.can_read_document_v2(
  p_organization_id uuid,p_visibility text,p_legacy_client_id text,p_employee_record_id text
)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_active_org_member(p_organization_id)
     or not public.has_org_capability(p_organization_id,'documents.read') then return false; end if;
  if public.current_member_role_key(p_organization_id)='client' then
    return p_visibility='CLIENT' and public.document_is_client_self(p_legacy_client_id);
  end if;
  if p_visibility='CONFIDENTIAL_REQUEST' then
    return public.document_is_employee_self(p_employee_record_id)
      or public.has_org_capability(p_organization_id,'requests.confidential.read');
  elsif p_visibility='HR_SENSITIVE' then
    return public.has_org_capability(p_organization_id,'hr.sensitive.read')
      or public.document_is_employee_self(p_employee_record_id);
  elsif p_visibility='FINANCE_SENSITIVE' then
    return public.has_org_capability(p_organization_id,'finance.read');
  elsif p_visibility='MANAGEMENT' then
    return public.has_org_capability(p_organization_id,'organization.manage')
      or public.has_org_capability(p_organization_id,'members.manage');
  end if;
  return true;
end;
$$;

create or replace function public.document_storage_can_upload(p_object_name text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.document_files document
    where document.deleted_at is null and document.status='UPLOADING'
      and document.uploaded_by=auth.uid()
      and p_object_name=any(array[document.original_path,document.optimized_path,document.thumbnail_path])
      and (
        public.has_org_capability(document.organization_id,'documents.manage')
        or (
          document.document_type='Employee Document'
          and public.document_is_employee_self(document.employee_record_id)
          and public.has_org_capability(document.organization_id,'requests.create')
        )
      )
  );
$$;

with requested(role_key,capability_key) as (values
  ('owner','requests.read'),('owner','requests.create'),('owner','requests.approve'),
  ('owner','requests.policy.manage'),('owner','requests.confidential.read'),
  ('owner','requests.finance.read'),('owner','requests.admin.read'),
  ('admin','requests.read'),('admin','requests.create'),('admin','requests.approve'),
  ('admin','requests.policy.manage'),('admin','requests.confidential.read'),
  ('admin','requests.finance.read'),('admin','requests.admin.read'),
  ('manager','requests.read'),('manager','requests.create'),('manager','requests.approve'),
  ('account_manager','requests.read'),('account_manager','requests.create'),('account_manager','requests.approve'),
  ('sales','requests.read'),('sales','requests.create'),
  ('finance','requests.read'),('finance','requests.create'),('finance','requests.approve'),('finance','requests.finance.read'),
  ('hr','requests.read'),('hr','requests.create'),('hr','requests.approve'),
  ('hr','requests.policy.manage'),('hr','requests.confidential.read'),('hr','requests.finance.read'),
  ('content_creator','requests.read'),('content_creator','requests.create'),
  ('designer','requests.read'),('designer','requests.create')
)
insert into public.role_capabilities(role_id,capability_id)
select role.id,capability.id
from requested
join public.organization_roles role on role.key=requested.role_key and role.organization_id is not null
join public.capabilities capability on capability.key=requested.capability_key
on conflict do nothing;

create table if not exists public.employee_request_type_policies_v3 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  type_key text not null check (type_key=lower(btrim(type_key)) and type_key~'^[a-z0-9_]+$'),
  version integer not null default 1 check (version>0),
  is_current boolean not null default true,
  enabled boolean not null default true,
  name_en text not null check (char_length(btrim(name_en)) between 2 and 120),
  name_ar text not null check (char_length(btrim(name_ar)) between 2 and 120),
  category text not null check (category in (
    'LEAVE','ATTENDANCE','REMOTE_WORK','SCHEDULE','OVERTIME','EXPENSE',
    'SALARY_ADVANCE','EQUIPMENT','HR_DOCUMENT','CONFIDENTIAL','GENERAL'
  )),
  classification text not null default 'INTERNAL' check (classification in (
    'INTERNAL','HR_SENSITIVE','FINANCE_SENSITIVE','CONFIDENTIAL','MEDICAL'
  )),
  form_schema jsonb not null default '{}'::jsonb check (jsonb_typeof(form_schema)='object'),
  approval_route jsonb not null default '[]'::jsonb check (jsonb_typeof(approval_route)='array'),
  policy jsonb not null default '{}'::jsonb check (jsonb_typeof(policy)='object'),
  effective_from date not null default current_date,
  effective_to date,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique(organization_id,type_key,version),
  check (effective_to is null or effective_to>=effective_from),
  check (is_current=(archived_at is null))
);
create unique index if not exists employee_request_type_current_v3_unique
  on public.employee_request_type_policies_v3(organization_id,type_key) where is_current;
create index if not exists employee_request_type_enabled_v3_idx
  on public.employee_request_type_policies_v3(organization_id,enabled,category,name_en) where is_current;

create table if not exists public.employee_request_holidays_v3 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  holiday_date date not null,
  name_en text not null,
  name_ar text not null,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(organization_id,holiday_date)
);

create table if not exists public.employee_requests_v3 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  request_number text not null,
  request_type_policy_id uuid not null references public.employee_request_type_policies_v3(id) on delete restrict,
  request_type_key text not null,
  category text not null,
  classification text not null,
  requester_user_id uuid not null references public.profiles(id) on delete restrict,
  employee_record_id text not null,
  direct_manager_user_id uuid references public.profiles(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 2 and 240),
  status text not null default 'DRAFT' check (status in (
    'DRAFT','SUBMITTED','PENDING_MANAGER','PENDING_HR','PENDING_FINANCE',
    'PENDING_ADMINISTRATION','NEEDS_INFORMATION','APPROVED','PARTIALLY_APPROVED',
    'REJECTED','CANCELLED','EXPIRED','COMPLETED'
  )),
  priority text not null default 'NORMAL' check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  request_date date not null default current_date,
  start_date date,
  end_date date,
  start_time time,
  end_time time,
  requested_units numeric(12,2) check (requested_units is null or requested_units>=0),
  approved_units numeric(12,2) check (approved_units is null or approved_units>=0),
  unit_kind text check (unit_kind is null or unit_kind in ('DAYS','HOURS','AMOUNT','ITEMS')),
  public_details jsonb not null default '{}'::jsonb check (jsonb_typeof(public_details)='object'),
  current_step integer not null default 0 check (current_step>=0),
  version integer not null default 1 check (version>0),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  effect_status text not null default 'NOT_REQUIRED' check (effect_status in ('NOT_REQUIRED','PENDING','APPLIED','CONFLICT','FAILED')),
  submitted_at timestamptz,
  decided_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(organization_id,id),
  unique(organization_id,request_number),
  unique(organization_id,requester_user_id,idempotency_key),
  check (end_date is null or start_date is null or end_date>=start_date)
);
create index if not exists employee_requests_v3_self_idx
  on public.employee_requests_v3(organization_id,requester_user_id,status,updated_at desc) where deleted_at is null;
create index if not exists employee_requests_v3_queue_idx
  on public.employee_requests_v3(organization_id,status,current_step,priority,submitted_at) where deleted_at is null;
create index if not exists employee_requests_v3_employee_idx
  on public.employee_requests_v3(organization_id,employee_record_id,start_date,end_date) where deleted_at is null;

create table if not exists public.employee_request_sensitive_v3 (
  organization_id uuid not null,
  request_id uuid not null,
  classification text not null check (classification in ('HR_SENSITIVE','FINANCE_SENSITIVE','CONFIDENTIAL','MEDICAL')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  updated_at timestamptz not null default now(),
  primary key(organization_id,request_id),
  foreign key(organization_id,request_id) references public.employee_requests_v3(organization_id,id) on delete restrict
);

create table if not exists public.employee_request_expense_lines_v3 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id uuid not null,
  line_no integer not null check (line_no between 1 and 100),
  expense_date date not null,
  category text not null,
  amount numeric(14,2) not null check (amount>0),
  currency text not null check (currency~'^[A-Z]{3}$'),
  client_or_project text,
  business_reason text not null,
  receipt_document_id uuid,
  foreign key(organization_id,request_id) references public.employee_requests_v3(organization_id,id) on delete restrict,
  foreign key(organization_id,receipt_document_id) references public.document_files(organization_id,id) on delete restrict,
  unique(organization_id,request_id,line_no)
);

create table if not exists public.employee_request_steps_v3 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id uuid not null,
  step_no integer not null check (step_no>0),
  step_type text not null check (step_type in ('MANAGER','HR','FINANCE','ADMINISTRATION','MANAGEMENT')),
  required_capability text,
  assigned_user_id uuid references public.profiles(id) on delete restrict,
  status text not null default 'WAITING' check (status in ('WAITING','PENDING','APPROVED','PARTIALLY_APPROVED','REJECTED','NEEDS_INFORMATION','SKIPPED')),
  decision_reason text,
  employee_visible boolean not null default true,
  acted_by uuid references public.profiles(id) on delete restrict,
  acted_at timestamptz,
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  foreign key(organization_id,request_id) references public.employee_requests_v3(organization_id,id) on delete restrict,
  unique(organization_id,request_id,step_no)
);
create index if not exists employee_request_steps_v3_queue_idx
  on public.employee_request_steps_v3(organization_id,status,assigned_user_id,required_capability,created_at);

create table if not exists public.employee_request_events_v3 (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  request_id uuid not null,
  event_type text not null check (event_type in (
    'DRAFT_SAVED','SUBMITTED','UPDATED','INFORMATION_PROVIDED','APPROVED','PARTIALLY_APPROVED',
    'REJECTED','INFORMATION_REQUESTED','CANCELLED','EXPIRED','EFFECT_APPLIED',
    'EFFECT_CONFLICT','COMPLETED','DOCUMENT_ATTACHED'
  )),
  from_status text,
  to_status text,
  actor_user_id uuid references public.profiles(id) on delete set null,
  step_no integer,
  employee_visible boolean not null default true,
  note text,
  safe_context jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_context)='object'),
  occurred_at timestamptz not null default now(),
  foreign key(organization_id,request_id) references public.employee_requests_v3(organization_id,id) on delete restrict
);
create index if not exists employee_request_events_v3_timeline_idx
  on public.employee_request_events_v3(organization_id,request_id,occurred_at,id);

create table if not exists public.employee_request_documents_v3 (
  organization_id uuid not null,
  request_id uuid not null,
  document_id uuid not null,
  purpose text not null default 'ATTACHMENT',
  attached_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(organization_id,request_id,document_id),
  foreign key(organization_id,request_id) references public.employee_requests_v3(organization_id,id) on delete restrict,
  foreign key(organization_id,document_id) references public.document_files(organization_id,id) on delete restrict
);

create table if not exists public.employee_request_effects_v3 (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id uuid not null,
  effect_key text not null,
  target_collection text,
  target_record_id text,
  status text not null check (status in ('APPLIED','CONFLICT','FAILED')),
  safe_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key(organization_id,request_id) references public.employee_requests_v3(organization_id,id) on delete restrict,
  unique(organization_id,request_id,effect_key)
);

create or replace function public.employee_request_events_v3_append_only()
returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='employee_request_events_append_only'; end;
$$;
drop trigger if exists employee_request_events_v3_no_mutation on public.employee_request_events_v3;
create trigger employee_request_events_v3_no_mutation before update or delete on public.employee_request_events_v3
for each row execute function public.employee_request_events_v3_append_only();

create or replace function public.employee_request_employee_for_user_v3(p_user_id uuid)
returns text language sql stable security definer set search_path='' as $$
  select coalesce(
    (select link.employee_record_id from public.legacy_identity_links link
      where link.auth_user_id=p_user_id and link.link_status='CONFIRMED' and link.employee_record_id is not null limit 1),
    (select profile.employee_id from public.profiles profile where profile.id=p_user_id limit 1)
  );
$$;

create or replace function public.employee_request_manager_for_employee_v3(p_organization_id uuid,p_employee_record_id text)
returns uuid language sql stable security definer set search_path='' as $$
  select public.task_user_for_employee_v2(nullif(employee.data->>'managerId',''))
  from public.records employee
  where employee.organization_id=p_organization_id and employee.id=p_employee_record_id
    and employee.coll='employees' and employee.deleted_at is null
  limit 1;
$$;

create or replace function public.employee_request_can_manage_v3(p_organization_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.has_org_capability(p_organization_id,'requests.approve')
    or public.has_org_capability(p_organization_id,'hr.manage')
    or public.has_org_capability(p_organization_id,'finance.manage')
    or public.has_org_capability(p_organization_id,'organization.manage');
$$;

create or replace function public.employee_request_can_read_v3(
  p_organization_id uuid,p_requester_user_id uuid,p_classification text,p_request_id uuid
)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.read') then return false; end if;
  if p_requester_user_id=auth.uid() then return true; end if;
  if p_classification='CONFIDENTIAL' then return public.has_org_capability(p_organization_id,'requests.confidential.read'); end if;
  -- An assigned reviewer may read the non-sensitive request shell needed to
  -- decide it. The sensitive payload still has its own stricter RLS helper.
  if exists(
    select 1 from public.employee_request_steps_v3 step
    where step.request_id=p_request_id
      and (step.assigned_user_id=auth.uid()
        or (step.assigned_user_id is null and step.required_capability is not null
          and public.has_org_capability(p_organization_id,step.required_capability)))
  ) then return true; end if;
  if p_classification='FINANCE_SENSITIVE' then
    return public.has_org_capability(p_organization_id,'requests.finance.read');
  end if;
  if p_classification in ('HR_SENSITIVE','MEDICAL') then
    return public.has_org_capability(p_organization_id,'hr.sensitive.read');
  end if;
  return public.has_org_capability(p_organization_id,'hr.manage')
    or public.has_org_capability(p_organization_id,'organization.manage');
end;
$$;

create or replace function public.employee_request_sensitive_can_read_v3(
  p_organization_id uuid,p_request_id uuid,p_classification text
)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype;
begin
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and deleted_at is null;
  if req.id is null or not public.is_active_org_member(p_organization_id) then return false; end if;
  if req.requester_user_id=auth.uid() then return true; end if;
  if p_classification='CONFIDENTIAL' then return public.has_org_capability(p_organization_id,'requests.confidential.read'); end if;
  if p_classification='FINANCE_SENSITIVE' then return public.has_org_capability(p_organization_id,'requests.finance.read'); end if;
  return public.has_org_capability(p_organization_id,'hr.sensitive.read');
end;
$$;

create or replace function public.seed_employee_request_policies_v3(p_organization_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.employee_request_type_policies_v3(
    organization_id,type_key,name_en,name_ar,category,classification,form_schema,approval_route,policy
  )
  select p_organization_id,v.type_key,v.name_en,v.name_ar,v.category,v.classification,v.form_schema,v.approval_route,v.policy
  from (values
    ('annual_leave','Annual leave','إجازة سنوية','LEAVE','INTERNAL','{"fields":["startDate","endDate","dayPart","handoverPerson","handoverNotes","coverageTasks","contactAvailability"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"allowanceDays":21,"weekendDays":[5,6],"minNoticeDays":3,"maxConsecutiveDays":14,"attachment":"optional"}'::jsonb),
    ('sick_leave','Sick leave','إجازة مرضية','LEAVE','MEDICAL','{"fields":["startDate","endDate","dayPart","medicalCertificate","returnToWorkDate"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"allowanceDays":14,"weekendDays":[5,6],"medicalCertificateAfterDays":2,"attachment":"conditional"}'::jsonb),
    ('emergency_leave','Emergency leave','إجازة طارئة','LEAVE','HR_SENSITIVE','{"fields":["startDate","endDate","dayPart","emergencyContact","handoverNotes"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"allowanceDays":3,"weekendDays":[5,6],"minNoticeDays":0,"attachment":"optional"}'::jsonb),
    ('unpaid_leave','Unpaid leave','إجازة بدون مرتب','LEAVE','HR_SENSITIVE','{"fields":["startDate","endDate","dayPart","handoverPerson","handoverNotes"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"},{"step":"FINANCE","capability":"finance.manage"}]'::jsonb,'{"weekendDays":[5,6],"minNoticeDays":7,"attachment":"optional"}'::jsonb),
    ('early_leave','Permission to leave early','إذن انصراف مبكر','ATTENDANCE','INTERNAL','{"fields":["requestDate","requestedLeavingTime","normalShiftEnd","handoverStatus","urgentTasksCovered"]}'::jsonb,'[{"step":"MANAGER"}]'::jsonb,'{"maxHours":4,"attachment":"optional"}'::jsonb),
    ('late_arrival','Permission to arrive late','إذن تأخير','ATTENDANCE','INTERNAL','{"fields":["requestDate","expectedArrivalTime","normalShiftStart","issueType"]}'::jsonb,'[{"step":"MANAGER"}]'::jsonb,'{"maxHours":4,"attachment":"optional"}'::jsonb),
    ('delay_notification','Delay notification','إبلاغ تأخير','ATTENDANCE','INTERNAL','{"fields":["requestDate","expectedArrivalTime","normalShiftStart","issueType"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"sameDay":true,"attachment":"optional"}'::jsonb),
    ('work_from_home','Work from home','عمل من المنزل','REMOTE_WORK','INTERNAL','{"fields":["startDate","endDate","dayPart","tasksPlanned","expectedDeliverables","availabilityHours","communicationChannel","equipmentReady","clientMeetingsAffected"]}'::jsonb,'[{"step":"MANAGER"}]'::jsonb,'{"maxDaysPerMonth":8,"attachment":"optional"}'::jsonb),
    ('shift_change','Shift change','تغيير وردية','SCHEDULE','INTERNAL','{"fields":["requestDate","currentShift","requestedShift","swapEmployee","swapConfirmed"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"minNoticeDays":1,"attachment":"optional"}'::jsonb),
    ('day_off_replacement','Day-off replacement','تبديل يوم الإجازة','SCHEDULE','INTERNAL','{"fields":["originalDayOff","replacementDate"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"minNoticeDays":1,"attachment":"optional"}'::jsonb),
    ('overtime','Overtime request','طلب وقت إضافي','OVERTIME','INTERNAL','{"fields":["requestDate","startTime","endTime","clientOrProject","tasks","timing","evidenceLink","compensationType"]}'::jsonb,'[{"step":"MANAGER"},{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"maxHoursPerDay":6,"attachment":"optional"}'::jsonb),
    ('business_mission','Business mission / external meeting','مأمورية أو اجتماع خارجي','ATTENDANCE','INTERNAL','{"fields":["startDate","endDate","startTime","endTime","clientOrProject","location"]}'::jsonb,'[{"step":"MANAGER"}]'::jsonb,'{"attachment":"optional"}'::jsonb),
    ('expense_reimbursement','Expense reimbursement','استرداد مصروفات','EXPENSE','FINANCE_SENSITIVE','{"fields":["expenseLines","paymentMethod","financeNotes"]}'::jsonb,'[{"step":"MANAGER"},{"step":"FINANCE","capability":"finance.manage"}]'::jsonb,'{"receiptRequiredAbove":0,"attachment":"required"}'::jsonb),
    ('salary_advance','Salary advance','سلفة راتب','SALARY_ADVANCE','FINANCE_SENSITIVE','{"fields":["amount","currency","repaymentMethod","installmentCount","requestedPaymentDate","confidentialNotes"]}'::jsonb,'[{"step":"HR","capability":"hr.manage"},{"step":"FINANCE","capability":"finance.manage"},{"step":"MANAGEMENT","capability":"organization.manage"}]'::jsonb,'{"minAmount":1,"attachment":"optional"}'::jsonb),
    ('equipment','Equipment request','طلب معدات','EQUIPMENT','INTERNAL','{"fields":["equipmentCategory","requestedItem","quantity","requiredDate","clientOrProject","existingIssue","replacementOrNew","specifications","purchaseRequired"]}'::jsonb,'[{"step":"MANAGER"},{"step":"ADMINISTRATION","capability":"requests.admin.read"}]'::jsonb,'{"attachment":"optional","financeWhenPurchase":true}'::jsonb),
    ('employment_document','Employment document request','طلب مستند وظيفي','HR_DOCUMENT','HR_SENSITIVE','{"fields":["documentType","language","addressedTo","purpose","copies","deliveryFormat","requiredDate","specialWording","deliveryPreference"]}'::jsonb,'[{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"attachment":"optional"}'::jsonb),
    ('hr_letter','HR letter request','طلب خطاب HR','HR_DOCUMENT','HR_SENSITIVE','{"fields":["documentType","language","addressedTo","purpose","copies","deliveryFormat","requiredDate","specialWording","deliveryPreference"]}'::jsonb,'[{"step":"HR","capability":"hr.manage"}]'::jsonb,'{"attachment":"optional"}'::jsonb),
    ('confidential_hr','Confidential HR request','طلب HR سري','CONFIDENTIAL','CONFIDENTIAL','{"fields":["subject","category","description","peopleInvolved","incidentDate","preferredContactMethod","urgency","feelsUnsafe"]}'::jsonb,'[{"step":"HR","capability":"requests.confidential.read"}]'::jsonb,'{"attachment":"optional"}'::jsonb),
    ('general','General request','طلب عام','GENERAL','INTERNAL','{"fields":["reason","notes","preferredResponseDeadline"]}'::jsonb,'[{"step":"MANAGER"}]'::jsonb,'{"attachment":"optional"}'::jsonb)
  ) as v(type_key,name_en,name_ar,category,classification,form_schema,approval_route,policy)
  on conflict(organization_id,type_key,version) do nothing;
end;
$$;

select public.seed_employee_request_policies_v3(organization.id) from public.organizations organization where organization.deleted_at is null;

create or replace function public.list_employee_request_types_v3(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.read') then
    raise exception using errcode='42501',message='request_membership_required';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',policy.id,'key',policy.type_key,'nameEn',policy.name_en,'nameAr',policy.name_ar,
    'category',policy.category,'classification',policy.classification,'schema',policy.form_schema,
    'policy',policy.policy,'version',policy.version
  ) order by policy.category,policy.name_en)
  from public.employee_request_type_policies_v3 policy
  where policy.organization_id=p_organization_id and policy.is_current and policy.enabled),'[]'::jsonb);
end;
$$;

create or replace function public.get_employee_request_context_v3(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare employee_id text; employee_row public.records%rowtype; manager_id uuid; manager_name text;
begin
  if not public.is_active_org_member(p_organization_id)
     or not public.has_org_capability(p_organization_id,'requests.create') then
    raise exception using errcode='42501',message='request_create_required';
  end if;
  employee_id:=public.employee_request_employee_for_user_v3(auth.uid());
  select * into employee_row from public.records employee
  where employee.organization_id=p_organization_id and employee.coll='employees'
    and employee.id=employee_id and employee.deleted_at is null;
  if employee_row.id is null then raise exception using errcode='P0001',message='employee_identity_link_required'; end if;
  manager_id:=public.employee_request_manager_for_employee_v3(p_organization_id,employee_id);
  select coalesce(profile.full_name,profile.email) into manager_name from public.profiles profile where profile.id=manager_id;
  return jsonb_build_object(
    'employeeId',employee_id,
    'employeeName',coalesce(employee_row.data->>'fullName',employee_row.data->>'name','—'),
    'department',coalesce(employee_row.data->>'department',employee_row.data->>'departmentName','—'),
    'managerUserId',manager_id,
    'managerName',coalesce(manager_name,'—'),
    'shiftStart',coalesce(employee_row.data->>'shiftStart',employee_row.data->>'workStart',''),
    'shiftEnd',coalesce(employee_row.data->>'shiftEnd',employee_row.data->>'workEnd','')
  );
end;
$$;

create or replace function public.list_employee_request_policies_v3(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.is_active_org_member(p_organization_id)
     or not public.has_org_capability(p_organization_id,'requests.policy.manage') then
    raise exception using errcode='42501',message='request_policy_manage_required';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',policy.id,'key',policy.type_key,'nameEn',policy.name_en,'nameAr',policy.name_ar,
    'category',policy.category,'classification',policy.classification,'schema',policy.form_schema,
    'route',policy.approval_route,'policy',policy.policy,'version',policy.version,
    'enabled',policy.enabled,'effectiveFrom',policy.effective_from
  ) order by policy.category,policy.name_en)
  from public.employee_request_type_policies_v3 policy
  where policy.organization_id=p_organization_id and policy.is_current),'[]'::jsonb);
end;
$$;

create or replace function public.quote_employee_request_v3(
  p_organization_id uuid,p_type_key text,p_start_date date,p_end_date date,p_day_fraction numeric default 1
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee_id text; policy_row public.employee_request_type_policies_v3%rowtype; requested numeric:=0; allowance numeric; used numeric:=0; pending numeric:=0; conflicts integer:=0;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.create') then raise exception using errcode='42501',message='request_create_required'; end if;
  employee_id:=public.employee_request_employee_for_user_v3(auth.uid());
  if employee_id is null then raise exception using errcode='P0001',message='employee_identity_link_required'; end if;
  select * into policy_row from public.employee_request_type_policies_v3 where organization_id=p_organization_id and type_key=p_type_key and is_current and enabled;
  if policy_row.id is null then raise exception using errcode='22023',message='request_type_unavailable'; end if;
  if p_start_date is null then p_start_date:=current_date; end if;
  if p_end_date is null then p_end_date:=p_start_date; end if;
  if p_end_date<p_start_date then raise exception using errcode='22023',message='request_date_range_invalid'; end if;
  select count(*)*greatest(0.1,least(1,coalesce(p_day_fraction,1))) into requested
  from generate_series(p_start_date,p_end_date,interval '1 day') day
  where extract(isodow from day)::integer not in (select value::integer from jsonb_array_elements_text(coalesce(policy_row.policy->'weekendDays','[5,6]'::jsonb)) value)
    and not exists(select 1 from public.employee_request_holidays_v3 holiday where holiday.organization_id=p_organization_id and holiday.holiday_date=day::date);
  allowance:=case when (policy_row.policy->>'allowanceDays')~'^[0-9]+([.][0-9]+)?$' then (policy_row.policy->>'allowanceDays')::numeric else null end;
  select coalesce(sum(req.requested_units),0) into used from public.employee_requests_v3 req where req.organization_id=p_organization_id and req.employee_record_id=employee_id and req.request_type_key=p_type_key and req.status in ('APPROVED','PARTIALLY_APPROVED','COMPLETED') and date_part('year',coalesce(req.start_date,req.request_date))=date_part('year',p_start_date) and req.deleted_at is null;
  select coalesce(sum(req.requested_units),0) into pending from public.employee_requests_v3 req where req.organization_id=p_organization_id and req.employee_record_id=employee_id and req.request_type_key=p_type_key and req.status in ('SUBMITTED','PENDING_MANAGER','PENDING_HR','PENDING_FINANCE','PENDING_ADMINISTRATION','NEEDS_INFORMATION') and req.deleted_at is null;
  select count(*) into conflicts from public.employee_requests_v3 req where req.organization_id=p_organization_id and req.employee_record_id<>employee_id and req.category='LEAVE' and req.status in ('APPROVED','PARTIALLY_APPROVED','COMPLETED') and daterange(req.start_date,coalesce(req.end_date,req.start_date),'[]')&&daterange(p_start_date,p_end_date,'[]') and req.deleted_at is null;
  return jsonb_build_object('ok',true,'requested',requested,'unit','DAYS','allowance',allowance,'used',used,'pending',pending,'remaining',case when allowance is null then null else allowance-used-requested end,'teamConflicts',conflicts,'policyVersion',policy_row.version);
end;
$$;

create or replace function public.create_employee_request_upload_v3(
  p_organization_id uuid,p_title text,p_classification text,p_original_filename text,
  p_mime_type text,p_original_size_bytes bigint,p_generate_variants boolean default false
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare document_id uuid:=gen_random_uuid(); employee_id text; extension_value text;
declare original_object text; optimized_object text; thumbnail_object text;
declare normalized_classification text:=upper(btrim(coalesce(p_classification,'INTERNAL')));
declare visibility_value text;
begin
  if not public.is_active_org_member(p_organization_id)
     or not public.has_org_capability(p_organization_id,'requests.create') then
    raise exception using errcode='42501',message='request_create_required';
  end if;
  employee_id:=public.employee_request_employee_for_user_v3(auth.uid());
  if employee_id is null then raise exception using errcode='P0001',message='employee_identity_link_required'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then raise exception using errcode='22023',message='invalid_document_title'; end if;
  if p_original_size_bytes not between 1 and 26214400 then raise exception using errcode='22023',message='invalid_document_size'; end if;
  if lower(btrim(coalesce(p_mime_type,''))) not in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception using errcode='22023',message='unsupported_document_type'; end if;
  visibility_value:=case
    when normalized_classification='CONFIDENTIAL' then 'CONFIDENTIAL_REQUEST'
    when normalized_classification='FINANCE_SENSITIVE' then 'FINANCE_SENSITIVE'
    when normalized_classification in ('HR_SENSITIVE','MEDICAL') then 'HR_SENSITIVE'
    else 'INTERNAL' end;
  extension_value:=public.document_mime_extension(p_original_filename,p_mime_type);
  original_object:=p_organization_id::text||'/'||document_id::text||'/original.'||extension_value;
  if p_generate_variants is true and lower(p_mime_type) in ('image/jpeg','image/png','image/webp') then
    optimized_object:=p_organization_id::text||'/'||document_id::text||'/optimized.webp';
    thumbnail_object:=p_organization_id::text||'/'||document_id::text||'/thumbnail.webp';
  end if;
  insert into public.document_files(
    id,organization_id,title,document_type,visibility,employee_record_id,
    original_path,optimized_path,thumbnail_path,original_filename,mime_type,original_size_bytes,uploaded_by
  ) values (
    document_id,p_organization_id,btrim(p_title),'Employee Document',visibility_value,employee_id,
    original_object,optimized_object,thumbnail_object,
    left(regexp_replace(coalesce(p_original_filename,'document'),'[[:cntrl:]/\\]+',' ','g'),240),
    lower(btrim(p_mime_type)),p_original_size_bytes,auth.uid()
  );
  insert into public.document_events(organization_id,document_id,action,actor_user_id,safe_context)
  values(p_organization_id,document_id,'UPLOAD_STARTED',auth.uid(),jsonb_build_object('type','Employee Document','visibility',visibility_value,'source','employee_request'));
  return jsonb_build_object('ok',true,'id',document_id,'bucket','magnet-documents',
    'originalPath',original_object,'optimizedPath',optimized_object,'thumbnailPath',thumbnail_object,'version',1);
end;
$$;

create or replace function public.employee_request_enqueue_email_v3(
  p_organization_id uuid,p_recipient_user_id uuid,p_request_id uuid,p_event text,p_request_number text,p_type_name text,p_confidential boolean
)
returns void language plpgsql security definer set search_path='' as $$
declare recipient_email text; subject_value text; body_value text;
begin
  select lower(btrim(profile.email)) into recipient_email from public.profiles profile where profile.id=p_recipient_user_id and profile.email is not null;
  if recipient_email is null then return; end if;
  subject_value:=case p_event when 'SUBMITTED' then 'Magnet OS request awaiting action' when 'APPROVED' then 'Your Magnet OS request was approved' when 'REJECTED' then 'Your Magnet OS request was updated' when 'NEEDS_INFORMATION' then 'More information is required' else 'Magnet OS request update' end;
  body_value:=case when p_confidential then 'A confidential request in Magnet OS has a new status. Sign in to view it securely.' else 'Request '||p_request_number||' ('||p_type_name||') has a new status. Sign in to Magnet OS to review the exact request.' end;
  insert into public.outbox_messages(organization_id,kind,recipient_ref,payload,idempotency_key)
  values(p_organization_id,'EMAIL_INTERNAL','DIRECT_EMAIL',jsonb_build_object('purpose','NOTIFICATION','to',jsonb_build_array(recipient_email),'subject',subject_value,'text',body_value,'actorUserId',auth.uid()),'employee-request:'||p_request_id||':'||p_event||':'||p_recipient_user_id||':'||coalesce((select request.version::text from public.employee_requests_v3 request where request.id=p_request_id),'0'))
  on conflict(organization_id,kind,idempotency_key) do nothing;
end;
$$;

create or replace function public.employee_request_notify_step_v3(p_request_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; step public.employee_request_steps_v3%rowtype; recipient record; type_name text;
begin
  select * into req from public.employee_requests_v3 where id=p_request_id;
  select * into step from public.employee_request_steps_v3 where request_id=p_request_id and step_no=req.current_step;
  select policy.name_en into type_name from public.employee_request_type_policies_v3 policy where policy.id=req.request_type_policy_id;
  if step.assigned_user_id is not null then
    insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
    values(req.organization_id,step.assigned_user_id,'REQUEST_APPROVAL','INFO','Employee request awaiting action',case when req.classification='CONFIDENTIAL' then 'A confidential HR request needs review.' else req.request_number||' · '||type_name end,'requests','employee_request',req.id::text,'request:'||req.id||':step:'||step.step_no)
    on conflict do nothing;
    perform public.employee_request_enqueue_email_v3(req.organization_id,step.assigned_user_id,req.id,'SUBMITTED',req.request_number,type_name,req.classification='CONFIDENTIAL');
  else
    for recipient in
      select distinct member.user_id from public.organization_members member
      join public.organization_roles role on role.id=member.role_id
      join public.role_capabilities rc on rc.role_id=role.id
      join public.capabilities capability on capability.id=rc.capability_id
      where member.organization_id=req.organization_id and member.status='ACTIVE' and capability.key=step.required_capability and member.user_id<>req.requester_user_id
    loop
      insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
      values(req.organization_id,recipient.user_id,'REQUEST_APPROVAL','INFO','Employee request awaiting action',case when req.classification='CONFIDENTIAL' then 'A confidential HR request needs review.' else req.request_number||' · '||type_name end,'requests','employee_request',req.id::text,'request:'||req.id||':step:'||step.step_no||':'||recipient.user_id)
      on conflict do nothing;
      perform public.employee_request_enqueue_email_v3(req.organization_id,recipient.user_id,req.id,'SUBMITTED',req.request_number,type_name,req.classification='CONFIDENTIAL');
    end loop;
  end if;
end;
$$;

create or replace function public.submit_employee_request_v3(
  p_organization_id uuid,p_type_key text,p_title text,p_priority text,p_request_date date,
  p_start_date date,p_end_date date,p_start_time time,p_end_time time,
  p_public_details jsonb,p_sensitive_details jsonb,p_expense_lines jsonb,
  p_document_ids uuid[],p_idempotency_key text,p_save_draft boolean default false
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee_id text; manager_id uuid; employee_department text; policy_row public.employee_request_type_policies_v3%rowtype; req public.employee_requests_v3%rowtype; step_value jsonb; step_no integer:=0; step_name text; capability_name text; units numeric:=0; quote jsonb; document_id uuid; line jsonb; status_value text; route_value jsonb; reason_value text;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.create') then raise exception using errcode='42501',message='request_create_required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then raise exception using errcode='22023',message='request_idempotency_required'; end if;
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and requester_user_id=auth.uid() and idempotency_key=p_idempotency_key;
  if req.id is not null then return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',true); end if;
  employee_id:=public.employee_request_employee_for_user_v3(auth.uid());
  if employee_id is null then raise exception using errcode='P0001',message='employee_identity_link_required'; end if;
  if not exists(select 1 from public.records employee where employee.organization_id=p_organization_id and employee.id=employee_id and employee.coll='employees' and employee.deleted_at is null) then raise exception using errcode='23503',message='employee_record_not_found'; end if;
  select * into policy_row from public.employee_request_type_policies_v3 where organization_id=p_organization_id and type_key=p_type_key and is_current and enabled;
  if policy_row.id is null then raise exception using errcode='22023',message='request_type_unavailable'; end if;
  if p_public_details is null or jsonb_typeof(p_public_details)<>'object' then raise exception using errcode='22023',message='request_details_invalid'; end if;
  if p_sensitive_details is null or jsonb_typeof(p_sensitive_details)<>'object' then raise exception using errcode='22023',message='request_sensitive_details_invalid'; end if;
  if p_public_details ?| array['organizationId','employeeId','requesterUserId','status','approvers','balance','approvedBy'] then raise exception using errcode='22023',message='request_server_field_claim_rejected'; end if;
  if p_start_date is not null and p_end_date is not null and p_end_date<p_start_date then raise exception using errcode='22023',message='request_date_range_invalid'; end if;
  manager_id:=public.employee_request_manager_for_employee_v3(p_organization_id,employee_id);
  select coalesce(employee.data->>'department',employee.data->>'departmentName','') into employee_department
  from public.records employee where employee.organization_id=p_organization_id and employee.id=employee_id and employee.coll='employees' and employee.deleted_at is null;
  if policy_row.category='LEAVE' and not p_save_draft then
    quote:=public.quote_employee_request_v3(p_organization_id,p_type_key,p_start_date,p_end_date,case when p_public_details->>'dayPart'='HALF_DAY' then .5 else 1 end);
    units:=coalesce((quote->>'requested')::numeric,0);
    if quote->>'remaining' is not null and (quote->>'remaining')::numeric<0 then raise exception using errcode='P0001',message='leave_balance_insufficient'; end if;
  elsif policy_row.category='REMOTE_WORK' then
    select count(*) into units from generate_series(coalesce(p_start_date,p_request_date,current_date),coalesce(p_end_date,p_start_date,p_request_date,current_date),interval '1 day') day
    where extract(isodow from day)::integer not in (select value::integer from jsonb_array_elements_text(coalesce(policy_row.policy->'weekendDays','[5,6]'::jsonb)) value)
      and not exists(select 1 from public.employee_request_holidays_v3 holiday where holiday.organization_id=p_organization_id and holiday.holiday_date=day::date);
  elsif policy_row.type_key in ('late_arrival','delay_notification') then
    p_start_time:=case when coalesce(p_public_details->>'normalShiftStart','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'normalShiftStart')::time else p_start_time end;
    p_end_time:=case when coalesce(p_public_details->>'expectedArrivalTime','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'expectedArrivalTime')::time else p_end_time end;
    if p_start_time is not null and p_end_time is not null then units:=greatest(0,extract(epoch from (p_end_time-p_start_time))/3600); end if;
  elsif policy_row.type_key='early_leave' then
    p_start_time:=case when coalesce(p_public_details->>'requestedLeavingTime','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'requestedLeavingTime')::time else p_start_time end;
    p_end_time:=case when coalesce(p_public_details->>'normalShiftEnd','')~'^[0-2][0-9]:[0-5][0-9]' then (p_public_details->>'normalShiftEnd')::time else p_end_time end;
    if p_start_time is not null and p_end_time is not null then units:=greatest(0,extract(epoch from (p_end_time-p_start_time))/3600); end if;
  elsif policy_row.category in ('ATTENDANCE','SCHEDULE','OVERTIME') and p_start_time is not null and p_end_time is not null then
    units:=greatest(0,extract(epoch from (p_end_time-p_start_time))/3600);
  elsif policy_row.category='EXPENSE' then
    if p_expense_lines is null or jsonb_typeof(p_expense_lines)<>'array' or jsonb_array_length(p_expense_lines)=0 then raise exception using errcode='22023',message='expense_lines_required'; end if;
    select coalesce(sum((item->>'amount')::numeric),0) into units from jsonb_array_elements(p_expense_lines) item where coalesce(item->>'amount','')~'^[0-9]+([.][0-9]+)?$';
    if units<=0 then raise exception using errcode='22023',message='expense_total_invalid'; end if;
  elsif policy_row.category='SALARY_ADVANCE' then
    if coalesce(p_sensitive_details->>'amount','')!~'^[0-9]+([.][0-9]+)?$' then raise exception using errcode='22023',message='salary_advance_amount_invalid'; end if;
    units:=(p_sensitive_details->>'amount')::numeric;
  end if;
  reason_value:=coalesce(nullif(btrim(p_public_details->>'reason'),''),nullif(btrim(p_sensitive_details->>'reason'),''),nullif(btrim(p_sensitive_details->>'description'),''),nullif(btrim(p_sensitive_details->>'purpose'),''),case when policy_row.category='EXPENSE' then (select nullif(btrim(item->>'businessReason'),'') from jsonb_array_elements(coalesce(p_expense_lines,'[]'::jsonb)) item limit 1) end);
  if not p_save_draft and reason_value is null then raise exception using errcode='22023',message='request_reason_required'; end if;
  if not p_save_draft and policy_row.policy ? 'minNoticeDays' and coalesce(p_start_date,p_request_date,current_date)-current_date < (policy_row.policy->>'minNoticeDays')::integer then raise exception using errcode='P0001',message='request_minimum_notice_required'; end if;
  if not p_save_draft and policy_row.policy ? 'maxConsecutiveDays' and units > (policy_row.policy->>'maxConsecutiveDays')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if not p_save_draft and policy_row.policy ? 'maxHours' and units > (policy_row.policy->>'maxHours')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if not p_save_draft and policy_row.policy ? 'maxHoursPerDay' and units > (policy_row.policy->>'maxHoursPerDay')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if not p_save_draft and policy_row.type_key='sick_leave'
     and policy_row.policy ? 'medicalCertificateAfterDays'
     and units >= (policy_row.policy->>'medicalCertificateAfterDays')::numeric
     and coalesce(array_length(p_document_ids,1),0)=0 then
    raise exception using errcode='P0001',message='medical_certificate_required';
  end if;
  if not p_save_draft and exists(
    select 1 from public.employee_requests_v3 duplicate
    where duplicate.organization_id=p_organization_id and duplicate.employee_record_id=employee_id
      and duplicate.request_type_key=policy_row.type_key and duplicate.deleted_at is null
      and duplicate.status not in ('DRAFT','REJECTED','CANCELLED','EXPIRED')
      and daterange(coalesce(duplicate.start_date,duplicate.request_date),coalesce(duplicate.end_date,duplicate.start_date,duplicate.request_date),'[]')
        && daterange(coalesce(p_start_date,p_request_date,current_date),coalesce(p_end_date,p_start_date,p_request_date,current_date),'[]')
  ) then raise exception using errcode='P0001',message='duplicate_request_exists'; end if;
  if not p_save_draft and coalesce(policy_row.policy->>'attachment','optional')='required' and coalesce(array_length(p_document_ids,1),0)=0 then raise exception using errcode='P0001',message='request_attachment_required'; end if;
  status_value:=case when p_save_draft then 'DRAFT' else 'SUBMITTED' end;
  insert into public.employee_requests_v3(
    organization_id,request_number,request_type_policy_id,request_type_key,category,classification,
    requester_user_id,employee_record_id,direct_manager_user_id,title,status,priority,request_date,
    start_date,end_date,start_time,end_time,requested_units,unit_kind,public_details,idempotency_key,
    effect_status,submitted_at
  ) values (
    p_organization_id,'REQ-'||to_char(now(),'YYYYMM')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),policy_row.id,policy_row.type_key,policy_row.category,policy_row.classification,
    auth.uid(),employee_id,manager_id,left(btrim(p_title),240),status_value,case when upper(coalesce(p_priority,'NORMAL')) in ('LOW','NORMAL','HIGH','URGENT') then upper(p_priority) else 'NORMAL' end,coalesce(p_request_date,current_date),
    p_start_date,p_end_date,p_start_time,p_end_time,units,case when policy_row.category in ('LEAVE','REMOTE_WORK') then 'DAYS' when policy_row.category in ('ATTENDANCE','OVERTIME') then 'HOURS' when policy_row.category in ('EXPENSE','SALARY_ADVANCE') then 'AMOUNT' else null end,p_public_details,p_idempotency_key,
    case when policy_row.category in ('LEAVE','ATTENDANCE','REMOTE_WORK','SCHEDULE','OVERTIME','EXPENSE','SALARY_ADVANCE') then 'PENDING' else 'NOT_REQUIRED' end,case when p_save_draft then null else now() end
  ) returning * into req;
  if policy_row.classification<>'INTERNAL' then
    insert into public.employee_request_sensitive_v3(organization_id,request_id,classification,details)
    values(p_organization_id,req.id,policy_row.classification,coalesce(p_sensitive_details,'{}'::jsonb));
  end if;
  if policy_row.category='EXPENSE' then
    for line in select value from jsonb_array_elements(p_expense_lines) loop
      step_no:=step_no+1;
      insert into public.employee_request_expense_lines_v3(organization_id,request_id,line_no,expense_date,category,amount,currency,client_or_project,business_reason,receipt_document_id)
      values(p_organization_id,req.id,step_no,coalesce(nullif(line->>'expenseDate','')::date,current_date),left(coalesce(nullif(btrim(line->>'category'),''),'Other'),120),(line->>'amount')::numeric,upper(coalesce(nullif(line->>'currency',''),'EGP')),nullif(line->>'clientOrProject',''),left(coalesce(nullif(btrim(line->>'businessReason'),''),'Business expense'),1000),case when coalesce(line->>'receiptDocumentId','')~'^[a-f0-9-]{36}$' then (line->>'receiptDocumentId')::uuid else null end);
    end loop;
  end if;
  if p_document_ids is not null then foreach document_id in array p_document_ids loop
    if not exists(select 1 from public.document_files document where document.organization_id=p_organization_id and document.id=document_id and document.deleted_at is null and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)) then raise exception using errcode='42501',message='request_document_not_allowed'; end if;
    insert into public.employee_request_documents_v3(organization_id,request_id,document_id,attached_by) values(p_organization_id,req.id,document_id,auth.uid()) on conflict do nothing;
  end loop; end if;
  step_no:=0; route_value:=policy_row.approval_route;
  if policy_row.type_key='equipment' and lower(coalesce(p_public_details->>'purchaseRequired','false')) in ('true','1','yes') then route_value:=route_value||jsonb_build_array(jsonb_build_object('step','FINANCE','capability','finance.manage')); end if;
  if not p_save_draft then
    for step_value in select value from jsonb_array_elements(route_value) loop
      if step_value ? 'minAmount' and units < (step_value->>'minAmount')::numeric then continue; end if;
      if step_value ? 'maxAmount' and units > (step_value->>'maxAmount')::numeric then continue; end if;
      if step_value ? 'minDays' and units < (step_value->>'minDays')::numeric then continue; end if;
      if step_value ? 'maxDays' and units > (step_value->>'maxDays')::numeric then continue; end if;
      if step_value ? 'department' and lower(btrim(step_value->>'department'))<>lower(btrim(employee_department)) then continue; end if;
      step_no:=step_no+1; step_name:=upper(step_value->>'step'); capability_name:=nullif(step_value->>'capability','');
      if step_name='MANAGER' and manager_id is null then raise exception using errcode='P0001',message='direct_manager_required'; end if;
      insert into public.employee_request_steps_v3(organization_id,request_id,step_no,step_type,required_capability,assigned_user_id,status,employee_visible)
      values(p_organization_id,req.id,step_no,step_name,case when step_name='MANAGER' then null else capability_name end,case when step_name='MANAGER' then manager_id else null end,case when step_no=1 then 'PENDING' else 'WAITING' end,policy_row.classification<>'CONFIDENTIAL');
    end loop;
    if step_no=0 then raise exception using errcode='P0001',message='request_approval_route_missing'; end if;
    update public.employee_requests_v3 set current_step=1,status=case (select step_type from public.employee_request_steps_v3 where request_id=req.id and step_no=1) when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end,updated_at=now() where id=req.id returning * into req;
  end if;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,to_status,actor_user_id,employee_visible,safe_context)
  values(p_organization_id,req.id,case when p_save_draft then 'DRAFT_SAVED' else 'SUBMITTED' end,req.status,auth.uid(),true,jsonb_build_object('typeKey',req.request_type_key,'policyVersion',policy_row.version));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values(p_organization_id,auth.uid(),case when p_save_draft then 'employee_request.draft_saved' else 'employee_request.submitted' end,'employee_request',req.id::text,jsonb_build_object('typeKey',req.request_type_key,'classification',req.classification));
  if not p_save_draft then perform public.employee_request_notify_step_v3(req.id); end if;
  return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',false);
end;
$$;

-- Drafts are intentionally submitted through a separate command.  The browser
-- only identifies the draft; identity, policy, balance, duplicate detection and
-- approval routing are recalculated while the row is locked.
create or replace function public.submit_saved_employee_request_v3(
  p_organization_id uuid,p_request_id uuid,p_expected_version integer,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; policy_row public.employee_request_type_policies_v3%rowtype; manager_id uuid; employee_department text; units numeric:=0; quote jsonb; route_value jsonb; step_value jsonb; step_no integer:=0; step_name text; capability_name text; reason_value text;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.create') then raise exception using errcode='42501',message='request_create_required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then raise exception using errcode='22023',message='request_idempotency_required'; end if;
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and requester_user_id=auth.uid() and deleted_at is null for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if req.version<>p_expected_version then raise exception using errcode='40001',message='request_version_conflict'; end if;
  if req.status<>'DRAFT' then return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',true); end if;
  select * into policy_row from public.employee_request_type_policies_v3 where organization_id=p_organization_id and type_key=req.request_type_key and is_current and enabled;
  if policy_row.id is null then raise exception using errcode='P0001',message='request_type_unavailable'; end if;
  manager_id:=public.employee_request_manager_for_employee_v3(p_organization_id,req.employee_record_id);
  select coalesce(employee.data->>'department',employee.data->>'departmentName','') into employee_department from public.records employee where employee.organization_id=p_organization_id and employee.id=req.employee_record_id and employee.coll='employees' and employee.deleted_at is null;
  reason_value:=coalesce(nullif(btrim(req.public_details->>'reason'),''),(select nullif(btrim(sensitive.details->>'reason'),'') from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),(select nullif(btrim(sensitive.details->>'description'),'') from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),(select nullif(btrim(sensitive.details->>'purpose'),'') from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),(select nullif(btrim(line.business_reason),'') from public.employee_request_expense_lines_v3 line where line.request_id=req.id order by line.line_no limit 1));
  if reason_value is null then raise exception using errcode='22023',message='request_reason_required'; end if;
  if req.start_date is not null and req.end_date is not null and req.end_date<req.start_date then raise exception using errcode='22023',message='request_date_range_invalid'; end if;
  if coalesce(policy_row.policy->>'attachment','optional')='required' and not exists(select 1 from public.employee_request_documents_v3 document where document.request_id=req.id) then raise exception using errcode='P0001',message='request_attachment_required'; end if;
  if policy_row.category='LEAVE' then
    quote:=public.quote_employee_request_v3(p_organization_id,policy_row.type_key,req.start_date,req.end_date,case when req.public_details->>'dayPart'='HALF_DAY' then .5 else 1 end);
    units:=coalesce((quote->>'requested')::numeric,0);
    if quote->>'remaining' is not null and (quote->>'remaining')::numeric<0 then raise exception using errcode='P0001',message='leave_balance_insufficient'; end if;
  elsif policy_row.category='EXPENSE' then
    select coalesce(sum(line.amount),0) into units from public.employee_request_expense_lines_v3 line where line.request_id=req.id;
    if units<=0 then raise exception using errcode='22023',message='expense_total_invalid'; end if;
  elsif policy_row.category='SALARY_ADVANCE' then
    select case when coalesce(sensitive.details->>'amount','')~'^[0-9]+([.][0-9]+)?$' then (sensitive.details->>'amount')::numeric else 0 end into units from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id;
    if units<=0 then raise exception using errcode='22023',message='salary_advance_amount_invalid'; end if;
  else units:=coalesce(req.requested_units,0);
  end if;
  if policy_row.policy ? 'minNoticeDays' and coalesce(req.start_date,req.request_date,current_date)-current_date < (policy_row.policy->>'minNoticeDays')::integer then raise exception using errcode='P0001',message='request_minimum_notice_required'; end if;
  if policy_row.policy ? 'maxConsecutiveDays' and units > (policy_row.policy->>'maxConsecutiveDays')::numeric then raise exception using errcode='P0001',message='request_duration_exceeds_policy'; end if;
  if policy_row.type_key='sick_leave' and policy_row.policy ? 'medicalCertificateAfterDays' and units >= (policy_row.policy->>'medicalCertificateAfterDays')::numeric and not exists(select 1 from public.employee_request_documents_v3 document where document.request_id=req.id) then raise exception using errcode='P0001',message='medical_certificate_required'; end if;
  if exists(select 1 from public.employee_requests_v3 duplicate where duplicate.organization_id=p_organization_id and duplicate.employee_record_id=req.employee_record_id and duplicate.id<>req.id and duplicate.request_type_key=req.request_type_key and duplicate.deleted_at is null and duplicate.status not in ('DRAFT','REJECTED','CANCELLED','EXPIRED') and daterange(coalesce(duplicate.start_date,duplicate.request_date),coalesce(duplicate.end_date,duplicate.start_date,duplicate.request_date),'[]') && daterange(coalesce(req.start_date,req.request_date),coalesce(req.end_date,req.start_date,req.request_date),'[]')) then raise exception using errcode='P0001',message='duplicate_request_exists'; end if;
  route_value:=policy_row.approval_route;
  if policy_row.type_key='equipment' and lower(coalesce(req.public_details->>'purchaseRequired','false')) in ('true','1','yes') then route_value:=route_value||jsonb_build_array(jsonb_build_object('step','FINANCE','capability','finance.manage')); end if;
  for step_value in select value from jsonb_array_elements(route_value) loop
    if step_value ? 'minAmount' and units < (step_value->>'minAmount')::numeric then continue; end if;
    if step_value ? 'maxAmount' and units > (step_value->>'maxAmount')::numeric then continue; end if;
    if step_value ? 'minDays' and units < (step_value->>'minDays')::numeric then continue; end if;
    if step_value ? 'maxDays' and units > (step_value->>'maxDays')::numeric then continue; end if;
    if step_value ? 'department' and lower(btrim(step_value->>'department'))<>lower(btrim(employee_department)) then continue; end if;
    step_no:=step_no+1;step_name:=upper(step_value->>'step');capability_name:=nullif(step_value->>'capability','');
    if step_name='MANAGER' and manager_id is null then raise exception using errcode='P0001',message='direct_manager_required'; end if;
    insert into public.employee_request_steps_v3(organization_id,request_id,step_no,step_type,required_capability,assigned_user_id,status,employee_visible) values(p_organization_id,req.id,step_no,step_name,case when step_name='MANAGER' then null else capability_name end,case when step_name='MANAGER' then manager_id else null end,case when step_no=1 then 'PENDING' else 'WAITING' end,policy_row.classification<>'CONFIDENTIAL');
  end loop;
  if step_no=0 then raise exception using errcode='P0001',message='request_approval_route_missing'; end if;
  update public.employee_requests_v3 set request_type_policy_id=policy_row.id,direct_manager_user_id=manager_id,requested_units=units,current_step=1,status=case (select step_type from public.employee_request_steps_v3 where request_id=req.id and step_no=1) when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end,submitted_at=now(),updated_at=now(),version=version+1,idempotency_key=p_idempotency_key where id=req.id returning * into req;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,from_status,to_status,actor_user_id,employee_visible,safe_context) values(p_organization_id,req.id,'SUBMITTED','DRAFT',req.status,auth.uid(),true,jsonb_build_object('typeKey',req.request_type_key,'policyVersion',policy_row.version));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'employee_request.draft_submitted','employee_request',req.id::text,jsonb_build_object('typeKey',req.request_type_key,'classification',req.classification));
  perform public.employee_request_notify_step_v3(req.id);
  return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'replayed',false);
end;
$$;

create or replace function public.update_employee_request_policy_v3(
  p_organization_id uuid,p_type_key text,p_enabled boolean,p_name_en text,p_name_ar text,
  p_form_schema jsonb,p_approval_route jsonb,p_policy jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_policy public.employee_request_type_policies_v3%rowtype; next_policy public.employee_request_type_policies_v3%rowtype;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.policy.manage') then raise exception using errcode='42501',message='request_policy_manage_required'; end if;
  select * into current_policy from public.employee_request_type_policies_v3 where organization_id=p_organization_id and type_key=p_type_key and is_current for update;
  if current_policy.id is null then raise exception using errcode='P0001',message='request_policy_not_found'; end if;
  if p_form_schema is not null and jsonb_typeof(p_form_schema)<>'object' then raise exception using errcode='22023',message='request_form_schema_invalid'; end if;
  if p_approval_route is not null and (jsonb_typeof(p_approval_route)<>'array' or jsonb_array_length(p_approval_route)=0) then raise exception using errcode='22023',message='request_approval_route_invalid'; end if;
  if p_policy is not null and jsonb_typeof(p_policy)<>'object' then raise exception using errcode='22023',message='request_policy_invalid'; end if;
  update public.employee_request_type_policies_v3 set is_current=false,archived_at=now(),effective_to=current_date where id=current_policy.id;
  insert into public.employee_request_type_policies_v3(
    organization_id,type_key,version,is_current,enabled,name_en,name_ar,category,classification,
    form_schema,approval_route,policy,effective_from,created_by
  ) values (
    p_organization_id,current_policy.type_key,current_policy.version+1,true,coalesce(p_enabled,current_policy.enabled),
    coalesce(nullif(btrim(p_name_en),''),current_policy.name_en),coalesce(nullif(btrim(p_name_ar),''),current_policy.name_ar),
    current_policy.category,current_policy.classification,coalesce(p_form_schema,current_policy.form_schema),
    coalesce(p_approval_route,current_policy.approval_route),coalesce(p_policy,current_policy.policy),current_date,auth.uid()
  ) returning * into next_policy;
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values(p_organization_id,auth.uid(),'employee_request.policy_versioned','employee_request_policy',next_policy.id::text,jsonb_build_object('typeKey',next_policy.type_key,'fromVersion',current_policy.version,'toVersion',next_policy.version));
  return jsonb_build_object('ok',true,'id',next_policy.id,'typeKey',next_policy.type_key,'version',next_policy.version,'enabled',next_policy.enabled);
end;
$$;

create or replace function public.complete_employee_request_v3(
  p_organization_id uuid,p_request_id uuid,p_expected_version integer,p_document_id uuid default null,p_note text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='request_complete_required'; end if;
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and deleted_at is null for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if not (
    public.has_org_capability(p_organization_id,'organization.manage')
    or (req.category='HR_DOCUMENT' and public.has_org_capability(p_organization_id,'hr.manage'))
    or (req.category in ('EXPENSE','SALARY_ADVANCE') and public.has_org_capability(p_organization_id,'finance.manage'))
    or (req.category='EQUIPMENT' and public.has_org_capability(p_organization_id,'requests.admin.read'))
  ) then raise exception using errcode='42501',message='request_complete_required'; end if;
  if req.version<>p_expected_version then raise exception using errcode='40001',message='request_version_conflict'; end if;
  if req.status not in ('APPROVED','PARTIALLY_APPROVED') then raise exception using errcode='P0001',message='request_not_ready_for_completion'; end if;
  if req.category='HR_DOCUMENT' and p_document_id is null then raise exception using errcode='P0001',message='completed_document_required'; end if;
  if p_document_id is not null then
    if not exists(select 1 from public.document_files document where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null and document.status='ACTIVE') then raise exception using errcode='23503',message='completed_document_not_found'; end if;
    insert into public.employee_request_documents_v3(organization_id,request_id,document_id,purpose,attached_by) values(p_organization_id,req.id,p_document_id,'COMPLETED_DOCUMENT',auth.uid()) on conflict do nothing;
  end if;
  update public.employee_requests_v3 set status='COMPLETED',completed_at=now(),updated_at=now(),version=version+1 where id=req.id returning * into req;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,from_status,to_status,actor_user_id,employee_visible,note) values(p_organization_id,req.id,'COMPLETED','APPROVED','COMPLETED',auth.uid(),true,nullif(left(btrim(coalesce(p_note,'')),1000),''));
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
  values(p_organization_id,req.requester_user_id,'REQUEST_COMPLETED','SUCCESS',case when req.category='HR_DOCUMENT' then 'Your document is ready' else 'Your request is completed' end,req.request_number,'requests','employee_request',req.id::text,'request:'||req.id||':completed') on conflict do nothing;
  perform public.employee_request_enqueue_email_v3(p_organization_id,req.requester_user_id,req.id,'COMPLETED',req.request_number,case when req.category='HR_DOCUMENT' then 'Document ready' else 'Request completed' end,req.classification='CONFIDENTIAL');
  return jsonb_build_object('ok',true,'id',req.id,'status',req.status,'version',req.version);
end;
$$;

create or replace function public.apply_employee_request_effect_v3(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; details jsonb; target_id text; target_data jsonb; effect_key text; effect_date date; conflict_count integer:=0;
begin
  select * into req from public.employee_requests_v3 where id=p_request_id for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if req.status not in ('APPROVED','PARTIALLY_APPROVED') then raise exception using errcode='P0001',message='request_not_approved'; end if;
  if req.effect_status='APPLIED' then return jsonb_build_object('ok',true,'replayed',true); end if;
  select sensitive.details into details from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id;
  effect_key:=lower(req.category); target_id:='request-effect-'||replace(req.id::text,'-','');

  -- Attendance is never silently overwritten. Existing rows become a visible
  -- conflict for HR to reconcile through the audited attendance workflow.
  if req.category in ('LEAVE','REMOTE_WORK') then
    select count(*) into conflict_count from public.records record
    where record.organization_id=req.organization_id and record.coll='attendance' and record.deleted_at is null
      and record.data->>'employeeId'=req.employee_record_id
      and coalesce(record.data->>'date','')~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and nullif(record.data->>'date','')::date between coalesce(req.start_date,req.request_date) and coalesce(req.end_date,req.start_date,req.request_date)
      and coalesce(record.data->>'requestId','')<>req.id::text;
  elsif req.category in ('ATTENDANCE','SCHEDULE','OVERTIME') then
    select count(*) into conflict_count from public.records record
    where record.organization_id=req.organization_id and record.coll='attendance' and record.deleted_at is null
      and record.data->>'employeeId'=req.employee_record_id
      and record.data->>'date'=coalesce(req.start_date,req.request_date)::text
      and coalesce(record.data->>'requestId','')<>req.id::text;
  end if;
  if conflict_count>0 then
    update public.employee_requests_v3 set effect_status='CONFLICT',updated_at=now(),version=version+1 where id=req.id;
    insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,status,safe_context)
    values(req.organization_id,req.id,effect_key,'attendance','CONFLICT',jsonb_build_object('conflictingRows',conflict_count)) on conflict do nothing;
    insert into public.employee_request_events_v3(organization_id,request_id,event_type,actor_user_id,employee_visible,safe_context)
    values(req.organization_id,req.id,'EFFECT_CONFLICT',auth.uid(),false,jsonb_build_object('targetCollection','attendance','conflictingRows',conflict_count));
    return jsonb_build_object('ok',false,'error','attendance_conflict','conflicts',conflict_count);
  end if;

  if req.category='LEAVE' then
    target_data:=jsonb_build_object('id',target_id,'employeeId',req.employee_record_id,'leaveType',req.request_type_key,'startDate',req.start_date,'endDate',coalesce(req.end_date,req.start_date),'days',coalesce(req.approved_units,req.requested_units),'reason',coalesce(req.public_details->>'reason',''),'status','Approved','source','employee_request_v3','requestId',req.id,'createdAt',now(),'updatedAt',now());
    insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by) values(target_id,'leaves',target_data,req.organization_id,now(),now(),auth.uid()::text,auth.uid()::text) on conflict(id) do nothing;
    insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,target_record_id,status) values(req.organization_id,req.id,effect_key,'leaves',target_id,'APPLIED') on conflict do nothing;
    for effect_date in select generate_series(coalesce(req.start_date,req.request_date),coalesce(req.end_date,req.start_date,req.request_date),interval '1 day')::date loop
      target_id:='request-effect-'||replace(req.id::text,'-','')||'-'||to_char(effect_date,'YYYYMMDD');
      target_data:=jsonb_build_object('id',target_id,'employeeId',req.employee_record_id,'date',effect_date,'status','On Leave','leaveType',req.request_type_key,'source','employee_request_v3','requestId',req.id,'createdAt',now(),'updatedAt',now());
      insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by) values(target_id,'attendance',target_data,req.organization_id,now(),now(),auth.uid()::text,auth.uid()::text) on conflict(id) do nothing;
      insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,target_record_id,status) values(req.organization_id,req.id,'leave-attendance-'||effect_date,'attendance',target_id,'APPLIED') on conflict do nothing;
    end loop;
  elsif req.category='REMOTE_WORK' then
    for effect_date in select generate_series(coalesce(req.start_date,req.request_date),coalesce(req.end_date,req.start_date,req.request_date),interval '1 day')::date loop
      target_id:='request-effect-'||replace(req.id::text,'-','')||'-'||to_char(effect_date,'YYYYMMDD');
      target_data:=jsonb_build_object('id',target_id,'employeeId',req.employee_record_id,'date',effect_date,'status','Work From Home','source','employee_request_v3','requestId',req.id,'createdAt',now(),'updatedAt',now());
      insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by) values(target_id,'attendance',target_data,req.organization_id,now(),now(),auth.uid()::text,auth.uid()::text) on conflict(id) do nothing;
      insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,target_record_id,status) values(req.organization_id,req.id,'remote-work-'||effect_date,'attendance',target_id,'APPLIED') on conflict do nothing;
    end loop;
  elsif req.category in ('ATTENDANCE','SCHEDULE','OVERTIME') then
    target_data:=jsonb_build_object('id',target_id,'employeeId',req.employee_record_id,'date',case when req.request_type_key='day_off_replacement' then coalesce(req.public_details->>'replacementDate',req.request_date::text) else coalesce(req.start_date,req.request_date)::text end,'status',case when req.category='OVERTIME' then 'Overtime Approved' else 'Authorized' end,'fromTime',req.start_time,'toTime',req.end_time,'hours',coalesce(req.approved_units,req.requested_units),'requestType',req.request_type_key,'source','employee_request_v3','requestId',req.id,'createdAt',now(),'updatedAt',now());
    insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by) values(target_id,'attendance',target_data,req.organization_id,now(),now(),auth.uid()::text,auth.uid()::text) on conflict(id) do nothing;
    insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,target_record_id,status) values(req.organization_id,req.id,effect_key,'attendance',target_id,'APPLIED') on conflict do nothing;
  elsif req.category='EXPENSE' then
    target_data:=jsonb_build_object('id',target_id,'employeeId',req.employee_record_id,'date',req.request_date,'category','Employee reimbursement','amount',coalesce(req.approved_units,req.requested_units),'currency',coalesce((select line.currency from public.employee_request_expense_lines_v3 line where line.request_id=req.id order by line.line_no limit 1),'EGP'),'status','Approved for processing','source','employee_request_v3','requestId',req.id,'createdAt',now(),'updatedAt',now());
    insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by) values(target_id,'expenses',target_data,req.organization_id,now(),now(),auth.uid()::text,auth.uid()::text) on conflict(id) do nothing;
    insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,target_record_id,status) values(req.organization_id,req.id,effect_key,'expenses',target_id,'APPLIED') on conflict do nothing;
  elsif req.category='SALARY_ADVANCE' then
    target_data:=jsonb_build_object('id',target_id,'employeeId',req.employee_record_id,'date',req.request_date,'type','Salary Advance','amount',details->>'amount','currency',coalesce(details->>'currency','EGP'),'status','Approved for payroll processing','source','employee_request_v3','requestId',req.id,'createdAt',now(),'updatedAt',now());
    insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by) values(target_id,'employeePayments',target_data,req.organization_id,now(),now(),auth.uid()::text,auth.uid()::text) on conflict(id) do nothing;
    insert into public.employee_request_effects_v3(organization_id,request_id,effect_key,target_collection,target_record_id,status) values(req.organization_id,req.id,effect_key,'employeePayments',target_id,'APPLIED') on conflict do nothing;
  else
    update public.employee_requests_v3 set effect_status='NOT_REQUIRED',updated_at=now() where id=req.id;
    return jsonb_build_object('ok',true,'effect','not_required');
  end if;
  update public.employee_requests_v3 set effect_status='APPLIED',updated_at=now(),version=version+1 where id=req.id;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,from_status,to_status,actor_user_id,employee_visible,safe_context)
  values(req.organization_id,req.id,'EFFECT_APPLIED',req.status,req.status,auth.uid(),true,jsonb_build_object('effect',effect_key,'targetCollection',case when req.category='LEAVE' then 'leaves+attendance' when req.category in ('ATTENDANCE','REMOTE_WORK','SCHEDULE','OVERTIME') then 'attendance' when req.category='EXPENSE' then 'expenses' else 'employeePayments' end));
  return jsonb_build_object('ok',true,'effect',effect_key,'targetId',target_id);
exception when unique_violation then
  update public.employee_requests_v3 set effect_status='CONFLICT',updated_at=now(),version=version+1 where id=p_request_id;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,actor_user_id,employee_visible,safe_context) select organization_id,id,'EFFECT_CONFLICT',auth.uid(),false,jsonb_build_object('error','unique_conflict') from public.employee_requests_v3 where id=p_request_id;
  return jsonb_build_object('ok',false,'error','effect_conflict');
end;
$$;

create or replace function public.decide_employee_request_v3(
  p_organization_id uuid,p_request_id uuid,p_expected_version integer,p_action text,p_reason text,p_partial jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; step public.employee_request_steps_v3%rowtype; next_step public.employee_request_steps_v3%rowtype; action_value text:=upper(btrim(coalesce(p_action,''))); next_status text; type_name text; allowed boolean:=false; effect jsonb; partial_units numeric;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='request_membership_required'; end if;
  if action_value not in ('APPROVE','PARTIALLY_APPROVE','REJECT','REQUEST_INFORMATION') then raise exception using errcode='22023',message='request_action_invalid'; end if;
  if action_value in ('REJECT','REQUEST_INFORMATION') and char_length(btrim(coalesce(p_reason,'')))<2 then raise exception using errcode='22023',message='request_decision_reason_required'; end if;
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and deleted_at is null for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if req.version<>p_expected_version then raise exception using errcode='40001',message='request_version_conflict'; end if;
  if req.requester_user_id=auth.uid() then raise exception using errcode='42501',message='request_self_approval_forbidden'; end if;
  if action_value='PARTIALLY_APPROVE' then
    if coalesce(p_partial->>'approvedUnits','')!~'^[0-9]+([.][0-9]+)?$' then raise exception using errcode='22023',message='partial_approval_units_required'; end if;
    partial_units:=(p_partial->>'approvedUnits')::numeric;
    if req.requested_units is null or partial_units<=0 or partial_units>=req.requested_units then raise exception using errcode='22023',message='partial_approval_units_invalid'; end if;
  end if;
  select * into step from public.employee_request_steps_v3 where organization_id=p_organization_id and request_id=req.id and step_no=req.current_step for update;
  if step.id is null or step.status not in ('PENDING','NEEDS_INFORMATION') then raise exception using errcode='P0001',message='request_step_not_pending'; end if;
  allowed:=(step.assigned_user_id=auth.uid()) or (step.assigned_user_id is null and step.required_capability is not null and public.has_org_capability(p_organization_id,step.required_capability));
  if not allowed then raise exception using errcode='42501',message='request_approval_not_assigned'; end if;
  if action_value='REQUEST_INFORMATION' then
    update public.employee_request_steps_v3 set status='NEEDS_INFORMATION',decision_reason=left(btrim(p_reason),2000),acted_by=auth.uid(),acted_at=now(),version=version+1 where id=step.id;
    next_status:='NEEDS_INFORMATION';
  elsif action_value='REJECT' then
    update public.employee_request_steps_v3 set status='REJECTED',decision_reason=left(btrim(p_reason),2000),acted_by=auth.uid(),acted_at=now(),version=version+1 where id=step.id;
    next_status:='REJECTED';
  else
    update public.employee_request_steps_v3 set status=case when action_value='PARTIALLY_APPROVE' then 'PARTIALLY_APPROVED' else 'APPROVED' end,decision_reason=nullif(left(btrim(coalesce(p_reason,'')),2000),''),acted_by=auth.uid(),acted_at=now(),version=version+1 where id=step.id;
    if action_value='PARTIALLY_APPROVE' then update public.employee_requests_v3 set approved_units=partial_units where id=req.id; end if;
    select * into next_step from public.employee_request_steps_v3 where request_id=req.id and step_no>step.step_no and status='WAITING' order by step_no limit 1 for update;
    if next_step.id is not null then
      update public.employee_request_steps_v3 set status='PENDING',version=version+1 where id=next_step.id;
      next_status:=case next_step.step_type when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end;
      update public.employee_requests_v3 set status=next_status,current_step=next_step.step_no,version=version+1,updated_at=now() where id=req.id returning * into req;
    else
      next_status:=case when action_value='PARTIALLY_APPROVE' or exists(select 1 from public.employee_request_steps_v3 s where s.request_id=req.id and s.status='PARTIALLY_APPROVED') then 'PARTIALLY_APPROVED' else 'APPROVED' end;
    end if;
  end if;
  if next_step.id is null or action_value in ('REJECT','REQUEST_INFORMATION') then
    update public.employee_requests_v3 set status=next_status,version=version+1,updated_at=now(),decided_at=case when next_status in ('APPROVED','PARTIALLY_APPROVED','REJECTED') then now() else decided_at end where id=req.id returning * into req;
  end if;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,from_status,to_status,actor_user_id,step_no,employee_visible,note,safe_context)
  values(p_organization_id,req.id,case action_value when 'APPROVE' then 'APPROVED' when 'PARTIALLY_APPROVE' then 'PARTIALLY_APPROVED' when 'REJECT' then 'REJECTED' else 'INFORMATION_REQUESTED' end,case step.step_type when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end,next_status,auth.uid(),step.step_no,step.employee_visible,case when step.employee_visible then nullif(left(btrim(coalesce(p_reason,'')),2000),'') else null end,jsonb_build_object('stepType',step.step_type));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values(p_organization_id,auth.uid(),'employee_request.'||lower(action_value),'employee_request',req.id::text,jsonb_build_object('stepType',step.step_type,'fromStep',step.step_no,'toStatus',next_status));
  select policy.name_en into type_name from public.employee_request_type_policies_v3 policy where policy.id=req.request_type_policy_id;
  insert into public.user_notifications_v2(organization_id,recipient_user_id,notification_type,severity,title,message,route,entity_type,entity_id,source_key)
  values(p_organization_id,req.requester_user_id,'REQUEST_'||action_value,case when action_value='APPROVE' then 'SUCCESS' when action_value='REJECT' then 'WARNING' else 'INFO' end,case when action_value='APPROVE' and next_status='APPROVED' then 'Request approved' when action_value='REJECT' then 'Request rejected' when action_value='REQUEST_INFORMATION' then 'More information required' else 'Request updated' end,case when req.classification='CONFIDENTIAL' then 'Open Magnet OS to view this confidential update.' else req.request_number||' · '||type_name end,'requests','employee_request',req.id::text,'request:'||req.id||':'||action_value||':'||req.version)
  on conflict do nothing;
  perform public.employee_request_enqueue_email_v3(p_organization_id,req.requester_user_id,req.id,case when next_status in ('APPROVED','PARTIALLY_APPROVED') then 'APPROVED' when next_status='REJECTED' then 'REJECTED' when next_status='NEEDS_INFORMATION' then 'NEEDS_INFORMATION' else 'UPDATED' end,req.request_number,type_name,req.classification='CONFIDENTIAL');
  if next_status in ('APPROVED','PARTIALLY_APPROVED') and req.effect_status='PENDING' then effect:=public.apply_employee_request_effect_v3(req.id); end if;
  if next_step.id is not null then perform public.employee_request_notify_step_v3(req.id); end if;
  return jsonb_build_object('ok',true,'id',req.id,'requestNumber',req.request_number,'status',req.status,'version',req.version,'effect',effect);
end;
$$;

create or replace function public.respond_employee_request_v3(
  p_organization_id uuid,p_request_id uuid,p_expected_version integer,p_public_details jsonb,p_sensitive_details jsonb,p_document_ids uuid[] default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; step public.employee_request_steps_v3%rowtype; document_id uuid;
begin
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and requester_user_id=auth.uid() and deleted_at is null for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if req.version<>p_expected_version then raise exception using errcode='40001',message='request_version_conflict'; end if;
  if req.status not in ('DRAFT','NEEDS_INFORMATION') then raise exception using errcode='P0001',message='request_not_editable'; end if;
  if p_public_details ?| array['organizationId','employeeId','requesterUserId','status','approvers','balance','approvedBy'] then raise exception using errcode='22023',message='request_server_field_claim_rejected'; end if;
  if req.status='NEEDS_INFORMATION' then
    select * into step from public.employee_request_steps_v3 where request_id=req.id and step_no=req.current_step for update;
  end if;
  update public.employee_requests_v3 set public_details=coalesce(p_public_details,public_details),status=case when status='DRAFT' then 'DRAFT' else case step.step_type when 'MANAGER' then 'PENDING_MANAGER' when 'HR' then 'PENDING_HR' when 'FINANCE' then 'PENDING_FINANCE' else 'PENDING_ADMINISTRATION' end end,version=version+1,updated_at=now() where id=req.id returning * into req;
  if req.classification<>'INTERNAL' and p_sensitive_details is not null then update public.employee_request_sensitive_v3 set details=p_sensitive_details,updated_at=now() where request_id=req.id; end if;
  if step.status='NEEDS_INFORMATION' then update public.employee_request_steps_v3 set status='PENDING',decision_reason=null,acted_by=null,acted_at=null,version=version+1 where id=step.id; end if;
  if p_document_ids is not null then foreach document_id in array p_document_ids loop insert into public.employee_request_documents_v3(organization_id,request_id,document_id,attached_by) values(p_organization_id,req.id,document_id,auth.uid()) on conflict do nothing; end loop; end if;
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,actor_user_id,employee_visible,safe_context) values(p_organization_id,req.id,case when step.status='NEEDS_INFORMATION' then 'INFORMATION_PROVIDED' else 'UPDATED' end,auth.uid(),true,'{}'::jsonb);
  if step.status='NEEDS_INFORMATION' then perform public.employee_request_notify_step_v3(req.id); end if;
  return jsonb_build_object('ok',true,'id',req.id,'status',req.status,'version',req.version);
end;
$$;

create or replace function public.cancel_employee_request_v3(p_organization_id uuid,p_request_id uuid,p_expected_version integer,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype;
begin
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and requester_user_id=auth.uid() and deleted_at is null for update;
  if req.id is null then raise exception using errcode='P0001',message='request_not_found'; end if;
  if req.version<>p_expected_version then raise exception using errcode='40001',message='request_version_conflict'; end if;
  if req.status in ('APPROVED','PARTIALLY_APPROVED','REJECTED','CANCELLED','COMPLETED') then raise exception using errcode='P0001',message='request_not_cancellable'; end if;
  update public.employee_requests_v3 set status='CANCELLED',cancelled_at=now(),updated_at=now(),version=version+1 where id=req.id returning * into req;
  update public.employee_request_steps_v3 set status='SKIPPED',version=version+1 where request_id=req.id and status in ('WAITING','PENDING','NEEDS_INFORMATION');
  insert into public.employee_request_events_v3(organization_id,request_id,event_type,from_status,to_status,actor_user_id,employee_visible,note) values(p_organization_id,req.id,'CANCELLED',null,'CANCELLED',auth.uid(),true,nullif(left(btrim(coalesce(p_reason,'')),500),''));
  return jsonb_build_object('ok',true,'id',req.id,'status',req.status,'version',req.version);
end;
$$;

create or replace function public.list_employee_requests_v3(
  p_organization_id uuid,p_scope text default 'MINE',p_status text default null,p_type_key text default null,
  p_search text default null,p_from_date date default null,p_to_date date default null,p_page integer default 1,p_page_size integer default 30
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare scope_value text:=upper(coalesce(p_scope,'MINE')); page_value integer:=greatest(1,coalesce(p_page,1)); size_value integer:=least(100,greatest(1,coalesce(p_page_size,30))); total_value integer;
begin
  if not public.is_active_org_member(p_organization_id) or not public.has_org_capability(p_organization_id,'requests.read') then raise exception using errcode='42501',message='request_read_required'; end if;
  if scope_value not in ('MINE','QUEUE','AUTHORIZED','TEAM_CALENDAR') then raise exception using errcode='22023',message='request_scope_invalid'; end if;
  with allowed as (
    select req.*,policy.name_en,policy.name_ar
    from public.employee_requests_v3 req join public.employee_request_type_policies_v3 policy on policy.id=req.request_type_policy_id
    where req.organization_id=p_organization_id and req.deleted_at is null
      and (
        (scope_value<>'TEAM_CALENDAR' and public.employee_request_can_read_v3(req.organization_id,req.requester_user_id,req.classification,req.id))
        or (scope_value='TEAM_CALENDAR' and public.is_active_org_member(p_organization_id)
          and req.category in ('LEAVE','REMOTE_WORK','ATTENDANCE')
          and req.status in ('APPROVED','PARTIALLY_APPROVED','COMPLETED'))
      )
      and (scope_value<>'MINE' or req.requester_user_id=auth.uid())
      and (scope_value<>'QUEUE' or exists(select 1 from public.employee_request_steps_v3 step where step.request_id=req.id and step.step_no=req.current_step and step.status='PENDING' and (step.assigned_user_id=auth.uid() or (step.assigned_user_id is null and public.has_org_capability(p_organization_id,step.required_capability)))))
      and (scope_value<>'TEAM_CALENDAR' or (req.category in ('LEAVE','REMOTE_WORK','ATTENDANCE') and req.status in ('APPROVED','PARTIALLY_APPROVED','COMPLETED')))
      and (p_status is null or req.status=p_status)
      and (p_type_key is null or req.request_type_key=p_type_key)
      and (p_from_date is null or coalesce(req.start_date,req.request_date)>=p_from_date)
      and (p_to_date is null or coalesce(req.end_date,req.start_date,req.request_date)<=p_to_date)
      and (p_search is null or req.request_number ilike '%'||p_search||'%' or req.title ilike '%'||p_search||'%')
  )
  select count(*) into total_value from allowed;
  return jsonb_build_object('items',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',item.id,'requestNumber',item.request_number,'typeKey',item.request_type_key,
      'typeNameEn',item.name_en,'typeNameAr',item.name_ar,'category',item.category,
      'classification',item.classification,'title',case when scope_value='TEAM_CALENDAR' then item.name_en else item.title end,
      'employeeName',case when scope_value='TEAM_CALENDAR' then coalesce((select employee.data->>'fullName' from public.records employee where employee.organization_id=item.organization_id and employee.coll='employees' and employee.id=item.employee_record_id and employee.deleted_at is null), 'Team member') else null end,
      'status',item.status,'priority',item.priority,
      'requestDate',item.request_date,'startDate',item.start_date,'endDate',item.end_date,
      'startTime',item.start_time,'endTime',item.end_time,'requestedUnits',item.requested_units,'approvedUnits',item.approved_units,
      'unitKind',item.unit_kind,'currentStep',item.current_step,'version',item.version,
      'effectStatus',item.effect_status,'requesterUserId',item.requester_user_id,
      'isMine',item.requester_user_id=auth.uid(),'submittedAt',item.submitted_at,'updatedAt',item.updated_at,
      'currentReviewer',coalesce((select step.step_type from public.employee_request_steps_v3 step where step.request_id=item.id and step.step_no=item.current_step),'—')
    ) order by item.updated_at desc)
    from (select * from allowed order by updated_at desc limit size_value offset (page_value-1)*size_value) item
  ),'[]'::jsonb),'total',total_value,'page',page_value,'pageSize',size_value,'pages',greatest(1,ceil(total_value::numeric/size_value)::integer));
end;
$$;

create or replace function public.get_employee_request_v3(p_organization_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare req public.employee_requests_v3%rowtype; policy_row public.employee_request_type_policies_v3%rowtype; can_sensitive boolean;
begin
  select * into req from public.employee_requests_v3 where organization_id=p_organization_id and id=p_request_id and deleted_at is null;
  if req.id is null or not public.employee_request_can_read_v3(req.organization_id,req.requester_user_id,req.classification,req.id) then raise exception using errcode='42501',message='request_not_found'; end if;
  select * into policy_row from public.employee_request_type_policies_v3 where id=req.request_type_policy_id;
  can_sensitive:=req.classification='INTERNAL' or public.employee_request_sensitive_can_read_v3(p_organization_id,req.id,req.classification);
  if req.classification='CONFIDENTIAL' and req.requester_user_id<>auth.uid() then
    insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
    values(p_organization_id,auth.uid(),'employee_request.confidential_accessed','employee_request',req.id::text,jsonb_build_object('classification','CONFIDENTIAL'));
  end if;
  return jsonb_build_object('ok',true,'request',jsonb_build_object(
    'id',req.id,'requestNumber',req.request_number,'typeKey',req.request_type_key,'typeNameEn',policy_row.name_en,'typeNameAr',policy_row.name_ar,
    'category',req.category,'classification',req.classification,'title',req.title,'status',req.status,'priority',req.priority,
    'requestDate',req.request_date,'startDate',req.start_date,'endDate',req.end_date,'startTime',req.start_time,'endTime',req.end_time,
    'requestedUnits',req.requested_units,'approvedUnits',req.approved_units,'unitKind',req.unit_kind,'publicDetails',req.public_details,
    'sensitiveDetails',case when can_sensitive then coalesce((select sensitive.details from public.employee_request_sensitive_v3 sensitive where sensitive.request_id=req.id),'{}'::jsonb) else null end,
    'currentStep',req.current_step,'version',req.version,'effectStatus',req.effect_status,'isMine',req.requester_user_id=auth.uid(),
    'canCancel',req.requester_user_id=auth.uid() and req.status not in ('APPROVED','PARTIALLY_APPROVED','REJECTED','CANCELLED','COMPLETED'),
    'canDecide',req.requester_user_id<>auth.uid() and exists(select 1 from public.employee_request_steps_v3 step where step.request_id=req.id and step.step_no=req.current_step and step.status in ('PENDING','NEEDS_INFORMATION') and (step.assigned_user_id=auth.uid() or (step.assigned_user_id is null and public.has_org_capability(p_organization_id,step.required_capability)))),
    'submittedAt',req.submitted_at,'updatedAt',req.updated_at
  ),'steps',coalesce((select jsonb_agg(jsonb_build_object('stepNo',step.step_no,'stepType',step.step_type,'status',step.status,'decisionReason',case when step.employee_visible or public.employee_request_can_manage_v3(p_organization_id) then step.decision_reason else null end,'actedAt',step.acted_at) order by step.step_no) from public.employee_request_steps_v3 step where step.request_id=req.id),'[]'::jsonb),
  'timeline',coalesce((select jsonb_agg(jsonb_build_object('id',event.id,'type',event.event_type,'fromStatus',event.from_status,'toStatus',event.to_status,'stepNo',event.step_no,'note',event.note,'occurredAt',event.occurred_at) order by event.occurred_at,event.id) from public.employee_request_events_v3 event where event.request_id=req.id and (event.employee_visible or public.employee_request_can_manage_v3(p_organization_id))),'[]'::jsonb),
  'documents',coalesce((select jsonb_agg(jsonb_build_object('id',document.id,'title',document.title,'documentType',document.document_type,'mimeType',document.mime_type,'status',document.status)) from public.employee_request_documents_v3 link join public.document_files document on document.id=link.document_id where link.request_id=req.id and document.deleted_at is null and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)),'[]'::jsonb),
  'expenseLines',case when req.category='EXPENSE' and can_sensitive then coalesce((select jsonb_agg(jsonb_build_object('lineNo',line.line_no,'expenseDate',line.expense_date,'category',line.category,'amount',line.amount,'currency',line.currency,'clientOrProject',line.client_or_project,'businessReason',line.business_reason,'receiptDocumentId',line.receipt_document_id) order by line.line_no) from public.employee_request_expense_lines_v3 line where line.request_id=req.id),'[]'::jsonb) else '[]'::jsonb end);
end;
$$;

alter table public.employee_request_type_policies_v3 enable row level security;
alter table public.employee_request_holidays_v3 enable row level security;
alter table public.employee_requests_v3 enable row level security;
alter table public.employee_request_sensitive_v3 enable row level security;
alter table public.employee_request_expense_lines_v3 enable row level security;
alter table public.employee_request_steps_v3 enable row level security;
alter table public.employee_request_events_v3 enable row level security;
alter table public.employee_request_documents_v3 enable row level security;
alter table public.employee_request_effects_v3 enable row level security;

revoke all privileges on public.employee_request_type_policies_v3,public.employee_request_holidays_v3,public.employee_requests_v3,
  public.employee_request_sensitive_v3,public.employee_request_expense_lines_v3,public.employee_request_steps_v3,
  public.employee_request_events_v3,public.employee_request_documents_v3,public.employee_request_effects_v3 from public,anon,authenticated;
grant select,insert,update,delete on public.employee_request_type_policies_v3,public.employee_request_holidays_v3,public.employee_requests_v3,
  public.employee_request_sensitive_v3,public.employee_request_expense_lines_v3,public.employee_request_steps_v3,
  public.employee_request_events_v3,public.employee_request_documents_v3,public.employee_request_effects_v3 to service_role;
grant usage,select on sequence public.employee_request_events_v3_id_seq to service_role;
grant select on public.employee_request_type_policies_v3,public.employee_request_holidays_v3,public.employee_requests_v3,
  public.employee_request_sensitive_v3,public.employee_request_expense_lines_v3,public.employee_request_steps_v3,
  public.employee_request_events_v3,public.employee_request_documents_v3,public.employee_request_effects_v3 to authenticated;

create policy employee_request_policies_v3_member_read on public.employee_request_type_policies_v3 for select to authenticated
using (is_current and public.is_active_org_member(organization_id) and public.has_org_capability(organization_id,'requests.read'));
create policy employee_request_holidays_v3_member_read on public.employee_request_holidays_v3 for select to authenticated
using (public.is_active_org_member(organization_id) and public.has_org_capability(organization_id,'requests.read'));
create policy employee_requests_v3_authorized_read on public.employee_requests_v3 for select to authenticated
using (deleted_at is null and public.employee_request_can_read_v3(organization_id,requester_user_id,classification,id));
create policy employee_request_sensitive_v3_authorized_read on public.employee_request_sensitive_v3 for select to authenticated
using (public.employee_request_sensitive_can_read_v3(organization_id,request_id,classification));
create policy employee_request_expense_lines_v3_authorized_read on public.employee_request_expense_lines_v3 for select to authenticated
using (exists(select 1 from public.employee_requests_v3 req where req.id=request_id and req.organization_id=organization_id and public.employee_request_sensitive_can_read_v3(req.organization_id,req.id,'FINANCE_SENSITIVE')));
create policy employee_request_steps_v3_authorized_read on public.employee_request_steps_v3 for select to authenticated
using (exists(select 1 from public.employee_requests_v3 req where req.id=request_id and req.organization_id=organization_id and public.employee_request_can_read_v3(req.organization_id,req.requester_user_id,req.classification,req.id)));
create policy employee_request_events_v3_authorized_read on public.employee_request_events_v3 for select to authenticated
using (exists(select 1 from public.employee_requests_v3 req where req.id=request_id and req.organization_id=organization_id and public.employee_request_can_read_v3(req.organization_id,req.requester_user_id,req.classification,req.id) and (employee_visible or public.employee_request_can_manage_v3(req.organization_id))));
create policy employee_request_documents_v3_authorized_read on public.employee_request_documents_v3 for select to authenticated
using (exists(select 1 from public.employee_requests_v3 req where req.id=request_id and req.organization_id=organization_id and public.employee_request_can_read_v3(req.organization_id,req.requester_user_id,req.classification,req.id)));
create policy employee_request_effects_v3_manager_read on public.employee_request_effects_v3 for select to authenticated
using (public.employee_request_can_manage_v3(organization_id));

revoke all on function public.seed_employee_request_policies_v3(uuid) from public,anon,authenticated;
revoke all on function public.employee_request_enqueue_email_v3(uuid,uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.employee_request_notify_step_v3(uuid) from public,anon,authenticated;
revoke all on function public.apply_employee_request_effect_v3(uuid) from public,anon,authenticated;
revoke all on function public.employee_request_employee_for_user_v3(uuid) from public,anon,authenticated;
revoke all on function public.employee_request_manager_for_employee_v3(uuid,text) from public,anon,authenticated;
revoke all on function public.employee_request_can_manage_v3(uuid) from public,anon,authenticated;
revoke all on function public.employee_request_can_read_v3(uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.employee_request_sensitive_can_read_v3(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.list_employee_request_types_v3(uuid) from public,anon,authenticated;
revoke all on function public.get_employee_request_context_v3(uuid) from public,anon,authenticated;
revoke all on function public.list_employee_request_policies_v3(uuid) from public,anon,authenticated;
revoke all on function public.quote_employee_request_v3(uuid,text,date,date,numeric) from public,anon,authenticated;
revoke all on function public.create_employee_request_upload_v3(uuid,text,text,text,text,bigint,boolean) from public,anon,authenticated;
revoke all on function public.submit_employee_request_v3(uuid,text,text,text,date,date,date,time,time,jsonb,jsonb,jsonb,uuid[],text,boolean) from public,anon,authenticated;
revoke all on function public.submit_saved_employee_request_v3(uuid,uuid,integer,text) from public,anon,authenticated;
revoke all on function public.decide_employee_request_v3(uuid,uuid,integer,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.respond_employee_request_v3(uuid,uuid,integer,jsonb,jsonb,uuid[]) from public,anon,authenticated;
revoke all on function public.cancel_employee_request_v3(uuid,uuid,integer,text) from public,anon,authenticated;
revoke all on function public.update_employee_request_policy_v3(uuid,text,boolean,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.complete_employee_request_v3(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
revoke all on function public.list_employee_requests_v3(uuid,text,text,text,text,date,date,integer,integer) from public,anon,authenticated;
revoke all on function public.get_employee_request_v3(uuid,uuid) from public,anon,authenticated;
grant execute on function public.employee_request_can_manage_v3(uuid) to authenticated;
grant execute on function public.employee_request_can_read_v3(uuid,uuid,text,uuid) to authenticated;
grant execute on function public.employee_request_sensitive_can_read_v3(uuid,uuid,text) to authenticated;
grant execute on function public.list_employee_request_types_v3(uuid) to authenticated;
grant execute on function public.get_employee_request_context_v3(uuid) to authenticated;
grant execute on function public.list_employee_request_policies_v3(uuid) to authenticated;
grant execute on function public.quote_employee_request_v3(uuid,text,date,date,numeric) to authenticated;
grant execute on function public.create_employee_request_upload_v3(uuid,text,text,text,text,bigint,boolean) to authenticated;
grant execute on function public.submit_employee_request_v3(uuid,text,text,text,date,date,date,time,time,jsonb,jsonb,jsonb,uuid[],text,boolean) to authenticated;
grant execute on function public.submit_saved_employee_request_v3(uuid,uuid,integer,text) to authenticated;
grant execute on function public.decide_employee_request_v3(uuid,uuid,integer,text,text,jsonb) to authenticated;
grant execute on function public.respond_employee_request_v3(uuid,uuid,integer,jsonb,jsonb,uuid[]) to authenticated;
grant execute on function public.cancel_employee_request_v3(uuid,uuid,integer,text) to authenticated;
grant execute on function public.update_employee_request_policy_v3(uuid,text,boolean,text,text,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.complete_employee_request_v3(uuid,uuid,integer,uuid,text) to authenticated;
grant execute on function public.list_employee_requests_v3(uuid,text,text,text,text,date,date,integer,integer) to authenticated;
grant execute on function public.get_employee_request_v3(uuid,uuid) to authenticated;

insert into public.schema_migrations(version,description,applied_by)
values('20260902000100_employee_requests_v3','Policy-driven employee requests, approval routing, RLS and idempotent HR/finance effects','migration')
on conflict(version) do nothing;

commit;
