-- MAGNET OS V2 / M9: private document storage, metadata, and lifecycle.
--
-- File bytes live only in the private Supabase Storage bucket. The database
-- stores tenant-scoped metadata and opaque object paths. Browser writes are
-- limited to an upload slot created by an authorized server command; physical
-- deletes remain service-only so user mistakes stay recoverable.

begin;

insert into public.capabilities(key,description) values
  ('documents.read','Read authorized organization documents and previews'),
  ('documents.manage','Upload and manage authorized organization documents')
on conflict (key) do update set description=excluded.description;

with requested(role_key,capability_key) as (values
  ('owner','documents.read'),('owner','documents.manage'),
  ('admin','documents.read'),('admin','documents.manage'),
  ('manager','documents.read'),('manager','documents.manage'),
  ('account_manager','documents.read'),('account_manager','documents.manage'),
  ('sales','documents.read'),('sales','documents.manage'),
  ('finance','documents.read'),('finance','documents.manage'),
  ('hr','documents.read'),('hr','documents.manage'),
  ('content_creator','documents.read'),('content_creator','documents.manage'),
  ('designer','documents.read'),('designer','documents.manage'),
  ('client','documents.read')
)
insert into public.role_capabilities(role_id,capability_id)
select role.id,capability.id
from requested
join public.organization_roles role on role.key=requested.role_key and role.organization_id is not null
join public.capabilities capability on capability.key=requested.capability_key
on conflict do nothing;

create table if not exists public.document_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 2 and 240),
  document_type text not null check (document_type in (
    'Client File','Employee Document','CV','ID','Contract','Invoice',
    'Payment Receipt','Scanned Document','Company Document','Other'
  )),
  visibility text not null default 'INTERNAL' check (visibility in (
    'INTERNAL','CLIENT','HR_SENSITIVE','FINANCE_SENSITIVE','MANAGEMENT'
  )),
  reference_number text,
  document_date date,
  tags text[] not null default '{}',
  notes text,
  client_account_id uuid,
  legacy_client_id text,
  employee_record_id text,
  contract_id uuid,
  invoice_id uuid,
  payment_id uuid,
  bucket_id text not null default 'magnet-documents' check (bucket_id='magnet-documents'),
  original_path text not null unique,
  optimized_path text unique,
  thumbnail_path text unique,
  original_filename text not null,
  mime_type text not null,
  original_size_bytes bigint not null check (original_size_bytes between 1 and 26214400),
  optimized_size_bytes bigint check (optimized_size_bytes is null or optimized_size_bytes between 1 and 26214400),
  thumbnail_size_bytes bigint check (thumbnail_size_bytes is null or thumbnail_size_bytes between 1 and 5242880),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'UPLOADING' check (status in ('UPLOADING','ACTIVE','FAILED','ARCHIVED','DELETED')),
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  foreign key (organization_id,client_account_id)
    references public.client_accounts(organization_id,id) on delete restrict,
  foreign key (organization_id,contract_id)
    references public.agency_contracts(organization_id,id) on delete restrict,
  foreign key (organization_id,invoice_id)
    references public.finance_invoices(organization_id,id) on delete restrict,
  foreign key (payment_id)
    references public.finance_payments(id) on delete restrict,
  unique (organization_id,id)
);

create index if not exists document_files_org_status_date_idx
  on public.document_files(organization_id,status,document_date desc,updated_at desc);
create index if not exists document_files_client_idx
  on public.document_files(organization_id,client_account_id,updated_at desc)
  where deleted_at is null;
create index if not exists document_files_employee_idx
  on public.document_files(organization_id,employee_record_id,updated_at desc)
  where deleted_at is null;
create index if not exists document_files_search_idx
  on public.document_files(organization_id,lower(title),lower(coalesce(reference_number,'')))
  where deleted_at is null;

create table if not exists public.document_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  document_id uuid not null,
  action text not null check (action in (
    'UPLOAD_STARTED','UPLOAD_COMPLETED','METADATA_UPDATED','ARCHIVED','RESTORED','MOVED_TO_TRASH','UPLOAD_FAILED'
  )),
  actor_user_id uuid references public.profiles(id) on delete set null,
  safe_context jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_context)='object'),
  occurred_at timestamptz not null default now(),
  foreign key (organization_id,document_id)
    references public.document_files(organization_id,id) on delete restrict
);

create index if not exists document_events_document_idx
  on public.document_events(organization_id,document_id,occurred_at desc);

create table if not exists public.document_import_issues (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null,
  issue_code text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(organization_id,legacy_record_id,issue_code)
);

-- Existing linked files are preserved and inventoried. They are not falsely
-- presented as private Storage objects until an authorized user imports them.
insert into public.document_import_issues(organization_id,legacy_record_id,issue_code)
select record.organization_id,record.id,'LEGACY_EXTERNAL_LINK_REQUIRES_IMPORT'
from public.records record
where record.coll='files' and record.deleted_at is null
  and lower(coalesce(record.data->>'_del','false'))<>'true'
on conflict (organization_id,legacy_record_id,issue_code) do update set last_seen_at=now();

create or replace function public.document_mime_extension(p_filename text,p_mime_type text)
returns text
language plpgsql
immutable
set search_path=''
as $$
declare mime_value text:=lower(btrim(coalesce(p_mime_type,'')));
declare ext text:=lower(substring(coalesce(p_filename,'') from '\.([a-zA-Z0-9]{1,8})$'));
begin
  return case mime_value
    when 'application/pdf' then 'pdf'
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/heic' then 'heic'
    when 'text/plain' then 'txt'
    when 'text/csv' then 'csv'
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'docx'
    when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then 'xlsx'
    else case when ext in ('pdf','jpg','jpeg','png','webp','heic','txt','csv','docx','xlsx') then ext else 'bin' end
  end;
end;
$$;

create or replace function public.document_is_employee_self(p_employee_record_id text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select p_employee_record_id is not null and exists(
    select 1 from public.legacy_identity_links link
    where link.auth_user_id=auth.uid() and link.link_status='CONFIRMED'
      and link.employee_record_id=p_employee_record_id
  );
$$;

create or replace function public.document_is_client_self(p_legacy_client_id text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select p_legacy_client_id is not null and exists(
    select 1 from public.profiles profile
    where profile.id=auth.uid() and nullif(profile.client_id,'')=p_legacy_client_id
  );
$$;

create or replace function public.can_read_document_v2(
  p_organization_id uuid,p_visibility text,p_legacy_client_id text,p_employee_record_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not public.is_active_org_member(p_organization_id)
     or not public.has_org_capability(p_organization_id,'documents.read') then return false; end if;
  if public.current_member_role_key(p_organization_id)='client' then
    return p_visibility='CLIENT' and public.document_is_client_self(p_legacy_client_id);
  end if;
  if p_visibility='HR_SENSITIVE' then
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

create or replace function public.document_storage_can_read(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1 from public.document_files document
    where document.deleted_at is null and document.status in ('ACTIVE','ARCHIVED')
      and p_object_name=any(array[document.original_path,document.optimized_path,document.thumbnail_path])
      and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)
  );
$$;

create or replace function public.document_storage_can_upload(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1 from public.document_files document
    where document.deleted_at is null and document.status='UPLOADING'
      and document.uploaded_by=auth.uid()
      and p_object_name=any(array[document.original_path,document.optimized_path,document.thumbnail_path])
      and public.has_org_capability(document.organization_id,'documents.manage')
  );
$$;

create or replace function public.document_events_append_only()
returns trigger
language plpgsql
set search_path=''
as $$ begin raise exception using errcode='42501',message='document_events_append_only'; end; $$;

drop trigger if exists document_events_no_mutation on public.document_events;
create trigger document_events_no_mutation before update or delete on public.document_events
for each row execute function public.document_events_append_only();

create or replace function public.create_document_upload_v2(
  p_organization_id uuid,p_title text,p_document_type text,p_visibility text,
  p_original_filename text,p_mime_type text,p_original_size_bytes bigint,
  p_generate_variants boolean default false,
  p_reference_number text default null,p_document_date date default null,p_tags text[] default '{}',
  p_notes text default null,p_client_account_id uuid default null,p_employee_record_id text default null,
  p_contract_id uuid default null,p_invoice_id uuid default null,p_payment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare document_id uuid:=gen_random_uuid();
declare extension_value text;
declare legacy_client text;
declare original_object text;
declare optimized_object text;
declare thumbnail_object text;
declare normalized_visibility text:=upper(btrim(coalesce(p_visibility,'INTERNAL')));
declare normalized_type text:=btrim(coalesce(p_document_type,''));
begin
  if not public.has_org_capability(p_organization_id,'documents.manage') then
    raise exception using errcode='42501',message='documents_manage_required'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then
    raise exception using errcode='P0001',message='invalid_document_title'; end if;
  if normalized_type not in ('Client File','Employee Document','CV','ID','Contract','Invoice','Payment Receipt','Scanned Document','Company Document','Other') then
    raise exception using errcode='P0001',message='invalid_document_type'; end if;
  if normalized_visibility not in ('INTERNAL','CLIENT','HR_SENSITIVE','FINANCE_SENSITIVE','MANAGEMENT') then
    raise exception using errcode='P0001',message='invalid_document_visibility'; end if;
  if p_original_size_bytes not between 1 and 26214400 then
    raise exception using errcode='P0001',message='invalid_document_size'; end if;
  if lower(btrim(coalesce(p_mime_type,''))) not in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception using errcode='P0001',message='unsupported_document_type'; end if;
  if normalized_visibility='HR_SENSITIVE'
     and not public.has_org_capability(p_organization_id,'hr.manage')
     and not public.document_is_employee_self(p_employee_record_id) then
    raise exception using errcode='42501',message='hr_document_manage_required'; end if;
  if normalized_visibility='FINANCE_SENSITIVE'
     and not public.has_org_capability(p_organization_id,'finance.manage') then
    raise exception using errcode='42501',message='finance_document_manage_required'; end if;
  if normalized_visibility='MANAGEMENT'
     and not (public.has_org_capability(p_organization_id,'organization.manage')
       or public.has_org_capability(p_organization_id,'members.manage')) then
    raise exception using errcode='42501',message='management_document_manage_required'; end if;
  if p_client_account_id is not null then
    select client.legacy_record_id into legacy_client from public.client_accounts client
    where client.organization_id=p_organization_id and client.id=p_client_account_id and client.deleted_at is null;
    if legacy_client is null then raise exception using errcode='23503',message='document_client_not_found'; end if;
  elsif normalized_visibility='CLIENT' then raise exception using errcode='23514',message='client_document_requires_client'; end if;
  if p_employee_record_id is not null and not exists(
    select 1 from public.records record where record.organization_id=p_organization_id
      and record.id=p_employee_record_id and record.coll='employees' and record.deleted_at is null
  ) then raise exception using errcode='23503',message='document_employee_not_found'; end if;
  if p_contract_id is not null and not exists(select 1 from public.agency_contracts contract where contract.organization_id=p_organization_id and contract.id=p_contract_id and contract.deleted_at is null) then
    raise exception using errcode='23503',message='document_contract_not_found'; end if;
  if p_invoice_id is not null and not exists(select 1 from public.finance_invoices invoice where invoice.organization_id=p_organization_id and invoice.id=p_invoice_id and invoice.deleted_at is null) then
    raise exception using errcode='23503',message='document_invoice_not_found'; end if;
  if p_payment_id is not null and not exists(select 1 from public.finance_payments payment where payment.organization_id=p_organization_id and payment.id=p_payment_id and payment.deleted_at is null) then
    raise exception using errcode='23503',message='document_payment_not_found'; end if;
  extension_value:=public.document_mime_extension(p_original_filename,p_mime_type);
  original_object:=p_organization_id::text||'/'||document_id::text||'/original.'||extension_value;
  if p_generate_variants is true and lower(p_mime_type) in ('image/jpeg','image/png','image/webp') then
    optimized_object:=p_organization_id::text||'/'||document_id::text||'/optimized.webp';
    thumbnail_object:=p_organization_id::text||'/'||document_id::text||'/thumbnail.webp';
  end if;
  insert into public.document_files(
    id,organization_id,title,document_type,visibility,reference_number,document_date,tags,notes,
    client_account_id,legacy_client_id,employee_record_id,contract_id,invoice_id,payment_id,
    original_path,optimized_path,thumbnail_path,original_filename,mime_type,original_size_bytes,uploaded_by
  ) values (
    document_id,p_organization_id,btrim(p_title),normalized_type,normalized_visibility,
    nullif(btrim(coalesce(p_reference_number,'')),''),p_document_date,coalesce(p_tags,'{}'),
    nullif(btrim(coalesce(p_notes,'')),''),p_client_account_id,legacy_client,p_employee_record_id,
    p_contract_id,p_invoice_id,p_payment_id,original_object,optimized_object,thumbnail_object,
    left(regexp_replace(coalesce(p_original_filename,'document'),'[[:cntrl:]/\\]+',' ','g'),240),
    lower(btrim(p_mime_type)),p_original_size_bytes,auth.uid()
  );
  insert into public.document_events(organization_id,document_id,action,actor_user_id,safe_context)
  values(p_organization_id,document_id,'UPLOAD_STARTED',auth.uid(),jsonb_build_object('type',normalized_type,'visibility',normalized_visibility));
  return jsonb_build_object('ok',true,'id',document_id,'bucket','magnet-documents',
    'originalPath',original_object,'optimizedPath',optimized_object,'thumbnailPath',thumbnail_object,'version',1);
end;
$$;

create or replace function public.finalize_document_upload_v2(
  p_organization_id uuid,p_document_id uuid,p_checksum_sha256 text default null,
  p_optimized_size_bytes bigint default null,p_thumbnail_size_bytes bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare document_row public.document_files%rowtype;
begin
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null for update;
  if document_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if document_row.status<>'UPLOADING' then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
  if document_row.uploaded_by<>auth.uid() and not public.has_org_capability(p_organization_id,'documents.manage') then
    raise exception using errcode='42501',message='documents_manage_required'; end if;
  if p_checksum_sha256 is not null and p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='P0001',message='invalid_document_checksum'; end if;
  if not exists(select 1 from storage.objects object where object.bucket_id=document_row.bucket_id and object.name=document_row.original_path) then
    raise exception using errcode='P0001',message='original_upload_missing'; end if;
  if document_row.optimized_path is not null and not exists(select 1 from storage.objects object where object.bucket_id=document_row.bucket_id and object.name=document_row.optimized_path) then
    raise exception using errcode='P0001',message='optimized_upload_missing'; end if;
  if document_row.thumbnail_path is not null and not exists(select 1 from storage.objects object where object.bucket_id=document_row.bucket_id and object.name=document_row.thumbnail_path) then
    raise exception using errcode='P0001',message='thumbnail_upload_missing'; end if;
  update public.document_files set status='ACTIVE',checksum_sha256=p_checksum_sha256,
    optimized_size_bytes=p_optimized_size_bytes,thumbnail_size_bytes=p_thumbnail_size_bytes,
    finalized_at=now(),updated_at=now(),version=version+1
  where id=document_row.id;
  insert into public.document_events(organization_id,document_id,action,actor_user_id,safe_context)
  values(p_organization_id,document_row.id,'UPLOAD_COMPLETED',auth.uid(),jsonb_build_object('hasOptimized',document_row.optimized_path is not null,'hasThumbnail',document_row.thumbnail_path is not null));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values(p_organization_id,auth.uid(),'DOCUMENT_UPLOAD_COMPLETED','document',document_row.id::text,jsonb_build_object('type',document_row.document_type,'visibility',document_row.visibility));
  return jsonb_build_object('ok',true,'id',document_row.id,'status','ACTIVE','version',document_row.version+1);
end;
$$;

create or replace function public.cancel_document_upload_v2(p_organization_id uuid,p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare document_row public.document_files%rowtype;
begin
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.status='UPLOADING' for update;
  if document_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if document_row.uploaded_by<>auth.uid() and not public.has_org_capability(p_organization_id,'documents.manage') then
    raise exception using errcode='42501',message='documents_manage_required'; end if;
  update public.document_files set status='FAILED',updated_at=now(),version=version+1 where id=document_row.id;
  insert into public.document_events(organization_id,document_id,action,actor_user_id)
  values(p_organization_id,document_row.id,'UPLOAD_FAILED',auth.uid());
  return jsonb_build_object('ok',true,'status','FAILED');
end;
$$;

create or replace function public.list_documents_v2(
  p_organization_id uuid,p_search text default null,p_document_type text default null,
  p_visibility text default null,p_client_account_id uuid default null,p_employee_record_id text default null,
  p_status text default null,p_page integer default 1,p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare page_value integer:=greatest(1,coalesce(p_page,1));
declare size_value integer:=least(100,greatest(1,coalesce(p_page_size,25)));
declare total_value integer;
declare row_value jsonb;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='membership_required'; end if;
  with filtered as (
    select document.* from public.document_files document
    where document.organization_id=p_organization_id and document.deleted_at is null
      and document.status<>'UPLOADING'
      and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)
      and (nullif(btrim(coalesce(p_search,'')),'') is null or document.title ilike '%'||btrim(p_search)||'%'
        or coalesce(document.reference_number,'') ilike '%'||btrim(p_search)||'%'
        or coalesce(document.original_filename,'') ilike '%'||btrim(p_search)||'%')
      and (nullif(btrim(coalesce(p_document_type,'')),'') is null or document.document_type=p_document_type)
      and (nullif(btrim(coalesce(p_visibility,'')),'') is null or document.visibility=upper(btrim(p_visibility)))
      and (p_client_account_id is null or document.client_account_id=p_client_account_id)
      and (nullif(btrim(coalesce(p_employee_record_id,'')),'') is null or document.employee_record_id=p_employee_record_id)
      and (nullif(btrim(coalesce(p_status,'')),'') is null or document.status=upper(btrim(p_status)))
  )
  select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object(
    'id',listed.id,'title',listed.title,'documentType',listed.document_type,'visibility',listed.visibility,
    'referenceNumber',listed.reference_number,'documentDate',listed.document_date,'tags',listed.tags,
    'clientAccountId',listed.client_account_id,'legacyClientId',listed.legacy_client_id,
    'employeeRecordId',listed.employee_record_id,'mimeType',listed.mime_type,
    'originalFilename',listed.original_filename,'originalSizeBytes',listed.original_size_bytes,
    'status',listed.status,'thumbnailPath',listed.thumbnail_path,'version',listed.version,
    'createdAt',listed.created_at,'updatedAt',listed.updated_at
  ) order by listed.updated_at desc),'[]'::jsonb)
  into total_value,row_value
  from (select * from filtered order by updated_at desc offset (page_value-1)*size_value limit size_value) listed;
  return jsonb_build_object('items',row_value,'total',total_value,'page',page_value,'pageSize',size_value);
end;
$$;

create or replace function public.get_document_v2(p_organization_id uuid,p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare document_row public.document_files%rowtype;
begin
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null;
  if document_row.id is null or not public.can_read_document_v2(document_row.organization_id,document_row.visibility,document_row.legacy_client_id,document_row.employee_record_id) then
    return jsonb_build_object('ok',false,'error','not_found'); end if;
  return jsonb_build_object('ok',true,'document',jsonb_build_object(
    'id',document_row.id,'title',document_row.title,'documentType',document_row.document_type,
    'visibility',document_row.visibility,'referenceNumber',document_row.reference_number,
    'documentDate',document_row.document_date,'tags',document_row.tags,'notes',document_row.notes,
    'clientAccountId',document_row.client_account_id,'legacyClientId',document_row.legacy_client_id,
    'employeeRecordId',document_row.employee_record_id,'contractId',document_row.contract_id,
    'invoiceId',document_row.invoice_id,'paymentId',document_row.payment_id,'bucket',document_row.bucket_id,
    'originalPath',document_row.original_path,'optimizedPath',document_row.optimized_path,
    'thumbnailPath',document_row.thumbnail_path,'originalFilename',document_row.original_filename,
    'mimeType',document_row.mime_type,'originalSizeBytes',document_row.original_size_bytes,
    'optimizedSizeBytes',document_row.optimized_size_bytes,'thumbnailSizeBytes',document_row.thumbnail_size_bytes,
    'status',document_row.status,'version',document_row.version,'createdAt',document_row.created_at,
    'updatedAt',document_row.updated_at,'finalizedAt',document_row.finalized_at
  ),'timeline',coalesce((select jsonb_agg(jsonb_build_object(
    'action',event.action,'context',event.safe_context,'occurredAt',event.occurred_at
  ) order by event.occurred_at desc) from public.document_events event
    where event.organization_id=p_organization_id and event.document_id=document_row.id),'[]'::jsonb));
end;
$$;

create or replace function public.update_document_metadata_v2(
  p_organization_id uuid,p_document_id uuid,p_expected_version integer,p_title text,
  p_document_type text,p_visibility text,p_reference_number text default null,p_document_date date default null,
  p_tags text[] default '{}',p_notes text default null,p_client_account_id uuid default null,
  p_employee_record_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare document_row public.document_files%rowtype;
declare legacy_client text;
declare normalized_visibility text:=upper(btrim(coalesce(p_visibility,'')));
begin
  if not public.has_org_capability(p_organization_id,'documents.manage') then raise exception using errcode='42501',message='documents_manage_required'; end if;
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null for update;
  if document_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if document_row.version<>p_expected_version then raise exception using errcode='40001',message='document_version_conflict'; end if;
  if char_length(btrim(coalesce(p_title,''))) not between 2 and 240 then raise exception using errcode='P0001',message='invalid_document_title'; end if;
  if normalized_visibility not in ('INTERNAL','CLIENT','HR_SENSITIVE','FINANCE_SENSITIVE','MANAGEMENT') then raise exception using errcode='P0001',message='invalid_document_visibility'; end if;
  if normalized_visibility='HR_SENSITIVE' and not public.has_org_capability(p_organization_id,'hr.manage') and not public.document_is_employee_self(p_employee_record_id) then raise exception using errcode='42501',message='hr_document_manage_required'; end if;
  if normalized_visibility='FINANCE_SENSITIVE' and not public.has_org_capability(p_organization_id,'finance.manage') then raise exception using errcode='42501',message='finance_document_manage_required'; end if;
  if p_client_account_id is not null then
    select client.legacy_record_id into legacy_client from public.client_accounts client
    where client.organization_id=p_organization_id and client.id=p_client_account_id and client.deleted_at is null;
    if legacy_client is null then raise exception using errcode='23503',message='document_client_not_found'; end if;
  elsif normalized_visibility='CLIENT' then raise exception using errcode='23514',message='client_document_requires_client'; end if;
  update public.document_files set title=btrim(p_title),document_type=p_document_type,
    visibility=normalized_visibility,reference_number=nullif(btrim(coalesce(p_reference_number,'')),''),
    document_date=p_document_date,tags=coalesce(p_tags,'{}'),notes=nullif(btrim(coalesce(p_notes,'')),''),
    client_account_id=p_client_account_id,legacy_client_id=legacy_client,employee_record_id=p_employee_record_id,
    version=version+1,updated_at=now() where id=document_row.id;
  insert into public.document_events(organization_id,document_id,action,actor_user_id,safe_context)
  values(p_organization_id,document_row.id,'METADATA_UPDATED',auth.uid(),jsonb_build_object('changed','metadata'));
  return jsonb_build_object('ok',true,'version',document_row.version+1);
end;
$$;

create or replace function public.change_document_state_v2(
  p_organization_id uuid,p_document_id uuid,p_expected_version integer,p_action text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare document_row public.document_files%rowtype;
declare action_value text:=upper(btrim(coalesce(p_action,'')));
declare next_status text;
declare event_action text;
begin
  if not public.has_org_capability(p_organization_id,'documents.manage') then raise exception using errcode='42501',message='documents_manage_required'; end if;
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null for update;
  if document_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if document_row.version<>p_expected_version then raise exception using errcode='40001',message='document_version_conflict'; end if;
  if action_value='ARCHIVE' and document_row.status='ACTIVE' then next_status:='ARCHIVED';event_action:='ARCHIVED';
  elsif action_value='RESTORE' and document_row.status='ARCHIVED' then next_status:='ACTIVE';event_action:='RESTORED';
  elsif action_value='DELETE' and document_row.status in ('ACTIVE','ARCHIVED','FAILED') then next_status:='DELETED';event_action:='MOVED_TO_TRASH';
  else raise exception using errcode='P0001',message='invalid_document_transition'; end if;
  update public.document_files set status=next_status,archived_at=case when next_status='ARCHIVED' then now() when next_status='ACTIVE' then null else archived_at end,
    deleted_at=case when next_status='DELETED' then now() else null end,updated_at=now(),version=version+1 where id=document_row.id;
  insert into public.document_events(organization_id,document_id,action,actor_user_id,safe_context)
  values(p_organization_id,document_row.id,event_action,auth.uid(),jsonb_build_object('from',document_row.status,'to',next_status));
  insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
  values(p_organization_id,auth.uid(),'DOCUMENT_'||event_action,'document',document_row.id::text,jsonb_build_object('from',document_row.status,'to',next_status));
  return jsonb_build_object('ok',true,'status',next_status,'version',document_row.version+1);
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('magnet-documents','magnet-documents',false,26214400,array[
  'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

alter table public.document_files enable row level security;
alter table public.document_events enable row level security;
alter table public.document_import_issues enable row level security;
revoke all privileges on public.document_files,public.document_events,public.document_import_issues from public,anon,authenticated;
grant select,insert,update,delete on public.document_files,public.document_events,public.document_import_issues to service_role;
grant usage,select on sequence public.document_events_id_seq,public.document_import_issues_id_seq to service_role;

create policy document_files_authorized_read on public.document_files for select to authenticated
using (deleted_at is null and public.can_read_document_v2(organization_id,visibility,legacy_client_id,employee_record_id));
create policy document_events_authorized_read on public.document_events for select to authenticated
using (exists(select 1 from public.document_files document where document.id=document_events.document_id and document.organization_id=document_events.organization_id
  and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)));
create policy document_import_issues_manager_read on public.document_import_issues for select to authenticated
using (public.has_org_capability(organization_id,'documents.manage'));
grant select on public.document_files,public.document_events,public.document_import_issues to authenticated;

drop policy if exists magnet_documents_select on storage.objects;
drop policy if exists magnet_documents_insert on storage.objects;
create policy magnet_documents_select on storage.objects for select to authenticated
using (bucket_id='magnet-documents' and public.document_storage_can_read(name));
create policy magnet_documents_insert on storage.objects for insert to authenticated
with check (bucket_id='magnet-documents' and public.document_storage_can_upload(name));

revoke all on function public.document_mime_extension(text,text) from public,anon;
revoke all on function public.document_is_employee_self(text) from public,anon;
revoke all on function public.document_is_client_self(text) from public,anon;
revoke all on function public.can_read_document_v2(uuid,text,text,text) from public,anon;
revoke all on function public.document_storage_can_read(text) from public,anon;
revoke all on function public.document_storage_can_upload(text) from public,anon;
revoke all on function public.create_document_upload_v2(uuid,text,text,text,text,text,bigint,boolean,text,date,text[],text,uuid,text,uuid,uuid,uuid) from public,anon;
revoke all on function public.finalize_document_upload_v2(uuid,uuid,text,bigint,bigint) from public,anon;
revoke all on function public.cancel_document_upload_v2(uuid,uuid) from public,anon;
revoke all on function public.list_documents_v2(uuid,text,text,text,uuid,text,text,integer,integer) from public,anon;
revoke all on function public.get_document_v2(uuid,uuid) from public,anon;
revoke all on function public.update_document_metadata_v2(uuid,uuid,integer,text,text,text,text,date,text[],text,uuid,text) from public,anon;
revoke all on function public.change_document_state_v2(uuid,uuid,integer,text) from public,anon;
grant execute on function public.document_mime_extension(text,text) to authenticated,service_role;
grant execute on function public.document_is_employee_self(text) to authenticated,service_role;
grant execute on function public.document_is_client_self(text) to authenticated,service_role;
grant execute on function public.can_read_document_v2(uuid,text,text,text) to authenticated,service_role;
grant execute on function public.document_storage_can_read(text) to authenticated,service_role;
grant execute on function public.document_storage_can_upload(text) to authenticated,service_role;
grant execute on function public.create_document_upload_v2(uuid,text,text,text,text,text,bigint,boolean,text,date,text[],text,uuid,text,uuid,uuid,uuid) to authenticated,service_role;
grant execute on function public.finalize_document_upload_v2(uuid,uuid,text,bigint,bigint) to authenticated,service_role;
grant execute on function public.cancel_document_upload_v2(uuid,uuid) to authenticated,service_role;
grant execute on function public.list_documents_v2(uuid,text,text,text,uuid,text,text,integer,integer) to authenticated,service_role;
grant execute on function public.get_document_v2(uuid,uuid) to authenticated,service_role;
grant execute on function public.update_document_metadata_v2(uuid,uuid,integer,text,text,text,text,date,text[],text,uuid,text) to authenticated,service_role;
grant execute on function public.change_document_state_v2(uuid,uuid,integer,text) to authenticated,service_role;

insert into public.migration_audit(migration,note) values(
  '20260826010000_document_storage_v2',
  'Added private document metadata, upload slots, Storage RLS, image variant paths, permission-aware list/profile commands, optimistic metadata updates, recoverable archive/trash lifecycle, and legacy-file import inventory.'
);

commit;

-- Forward-only rollback: remove the UI entry points and revoke authenticated
-- RPC/Storage policies. Preserve private objects, metadata, events, and legacy
-- import inventory for recovery. Physical purging remains a separate service job.
