-- Additive builder resources. Existing Studio task access/version commands remain authoritative.
-- Rollback: withdraw builder UI and revoke new RPCs; retain all resources and snapshots.
begin;
create table public.studio_client_brands_v3 (
 organization_id uuid not null, client_account_id uuid not null, revision integer not null default 1,
 brand jsonb not null check(jsonb_typeof(brand)='object' and octet_length(brand::text)<8192),
 updated_by uuid not null references public.profiles(id) on delete restrict,updated_at timestamptz not null default now(),
 primary key(organization_id,client_account_id),foreign key(organization_id,client_account_id) references public.client_accounts(organization_id,id) on delete restrict
);
create table public.studio_templates_v3 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,task_id uuid not null,
 title text not null check(char_length(title) between 2 and 120),payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=230000),
 created_by uuid not null references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),
 foreign key(organization_id,task_id) references public.work_tasks(organization_id,id) on delete restrict
);
create table public.studio_shares_v3 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,document_id uuid not null,revision integer not null,
 token_hash text not null unique,payload jsonb not null,allow_review boolean not null default false,
 expires_at timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default now(),last_viewed_at timestamptz,
 created_by uuid not null references public.profiles(id) on delete restrict,
 foreign key(organization_id,document_id) references public.studio_documents_v2(organization_id,id) on delete restrict,
 foreign key(document_id,revision) references public.studio_versions_v2(document_id,revision) on delete restrict
);
create table public.studio_comments_v3 (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,document_id uuid not null,revision integer not null,
 page_id text,block_id text,body text not null check(char_length(body) between 1 and 2000),
 decision text check(decision in('COMMENT','APPROVE','CHANGES')),share_id uuid references public.studio_shares_v3(id) on delete restrict,
 actor_id uuid references public.profiles(id) on delete restrict,reviewer_name text,created_at timestamptz not null default now(),
 foreign key(organization_id,document_id) references public.studio_documents_v2(organization_id,id) on delete restrict,
 foreign key(document_id,revision) references public.studio_versions_v2(document_id,revision) on delete restrict
);
create index studio_templates_task_v3 on public.studio_templates_v3(organization_id,task_id);
create index studio_shares_document_v3 on public.studio_shares_v3(document_id);
create index studio_comments_document_v3 on public.studio_comments_v3(document_id,created_at);
create index studio_comments_share_v3 on public.studio_comments_v3(share_id,created_at);
alter table public.studio_client_brands_v3 enable row level security;
alter table public.studio_templates_v3 enable row level security;
alter table public.studio_shares_v3 enable row level security;
alter table public.studio_comments_v3 enable row level security;
revoke all on public.studio_client_brands_v3,public.studio_templates_v3,public.studio_shares_v3,public.studio_comments_v3 from public,anon,authenticated;
grant select on public.studio_client_brands_v3,public.studio_templates_v3,public.studio_shares_v3,public.studio_comments_v3 to service_role;
create function public.studio_builder_valid_v3(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare page jsonb;b jsonb;ids text[]:=array[]::text[];
begin
 if jsonb_typeof(p->'title') is distinct from 'string' or p->>'builder' is distinct from '1' or p->>'kind' is distinct from 'report' or char_length(btrim(coalesce(p->>'title','')))<2 or char_length(p->>'title')>240 or octet_length(p::text)>230000 or coalesce(p->>'language','') not in('en','ar') or coalesce(p->>'pageSize','') not in('portrait','landscape') or jsonb_typeof(p->'pages') is distinct from 'array' then return false;end if;
 if jsonb_array_length(p->'pages') not between 1 and 60 then return false;end if;
 if coalesce(p#>>'{brand,primary}','') !~ '^#[A-Fa-f0-9]{6}$' or coalesce(p#>>'{brand,secondary}','') !~ '^#[A-Fa-f0-9]{6}$' or coalesce(p#>>'{brand,accent}','') !~ '^#[A-Fa-f0-9]{6}$' or coalesce(p#>>'{brand,font}','') not in('Manrope','Readex Pro','Arial','Georgia') then return false;end if;
 for page in select value from jsonb_array_elements(p->'pages') loop
  if jsonb_typeof(page->'title') is distinct from 'string' or jsonb_typeof(page->'id') is distinct from 'string' or nullif(page->>'id','') is null or page->>'id'=any(ids) or jsonb_typeof(page->'blocks') is distinct from 'array' then return false;end if;ids:=array_append(ids,page->>'id');
  if jsonb_array_length(page->'blocks')>30 then return false;end if;
  for b in select value from jsonb_array_elements(page->'blocks') loop
   if jsonb_typeof(b->'title') is distinct from 'string' or jsonb_typeof(b->'text') is distinct from 'string' or jsonb_typeof(b->'id') is distinct from 'string' or nullif(b->>'id','') is null or b->>'id'=any(ids) or coalesce(b->>'type','') not in('cover','headline','paragraph','image','logo','big_number','metric_group','chart','table','comparison','swot','buyer_persona','timeline','services','pricing','campaign_performance','social_content','recommendation','action_plan','cta','spacer') or jsonb_typeof(b->'rows') is distinct from 'array' or coalesce(b->>'alignment','') not in('left','center','right') or coalesce(b->>'variant','') not in('standard','accent','minimal') or char_length(coalesce(b->>'text',''))>12000 or char_length(coalesce(b->>'title',''))>500 then return false;end if;
   ids:=array_append(ids,b->>'id');
   if jsonb_typeof(b->'height') is distinct from 'number' or (b->>'height')::numeric not between 30 and 900 or jsonb_array_length(b->'rows')>50 then return false;end if;
   if exists(select 1 from jsonb_array_elements(b->'rows') r where jsonb_typeof(r) is distinct from 'array') then return false;end if;
   if exists(select 1 from jsonb_array_elements(b->'rows') r where jsonb_array_length(r)>6 or exists(select 1 from jsonb_array_elements(r) cell where jsonb_typeof(cell) is distinct from 'string' or char_length(cell#>>'{}')>1000)) then return false;end if;
  end loop;
 end loop;return true;
exception when others then return false;
end;$$;
create function public.studio_builder_guard_v3() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.payload ? 'builder' and not coalesce(public.studio_builder_valid_v3(new.payload),false) then raise exception 'studio_builder_invalid';end if;return new;
end;$$;
create trigger studio_builder_payload_guard before insert on public.studio_versions_v2 for each row execute function public.studio_builder_guard_v3();
create function public.studio_resources_v3(p_organization_id uuid,p_task_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t public.work_tasks%rowtype;kit jsonb;templates jsonb;
begin
 if not public.studio_task_access_v2(p_organization_id,p_task_id) then raise exception using errcode='42501',message='studio_access_required';end if;
 select * into t from public.work_tasks where id=p_task_id;
 select jsonb_build_object('revision',b.revision,'brand',b.brand) into kit from public.studio_client_brands_v3 b where b.organization_id=p_organization_id and b.client_account_id=t.client_account_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'payload',x.payload) order by x.created_at desc),'[]') into templates from public.studio_templates_v3 x join public.work_tasks xt on xt.id=x.task_id where x.organization_id=p_organization_id and xt.client_account_id=t.client_account_id and public.studio_task_access_v2(p_organization_id,xt.id);
 return jsonb_build_object('ok',true,'kit',kit,'templates',templates,'canManageBrand',public.has_org_capability(p_organization_id,'clients.manage'),'canShare',public.has_org_capability(p_organization_id,'documents.manage'),
 'sources',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'type',r.coll,'title',coalesce(r.data->>'title',r.data->>'name'),'summary',coalesce(r.data->>'executiveSummary',r.data->>'scope',r.data->>'caption',r.data->>'objective'),'metrics',r.data->>'kpiSummary','recommendations',r.data->>'recommendations','nextPlan',r.data->>'nextPlan','service',r.data->>'serviceType','price',r.data->>'price','currency',r.data->>'currency','timeline',coalesce(r.data->>'timeline',r.data->>'scheduledDate'),'status',r.data->>'status') order by r.id) from public.records r where r.organization_id=p_organization_id and r.coll in('proposals','reports','contentCalendar','briefs','campaigns') and r.deleted_at is null and r.data->>'clientId'=t.legacy_client_id and public.records_can_read(r.organization_id,r.coll,r.data) and (r.coll<>'reports' or coalesce(r.data->>'reportKind','Client')='Client') and (r.coll<>'contentCalendar' or r.data->>'approvalStatus'='Approved' or r.data->>'status'='Approved')),'[]'::jsonb));
end;$$;
create function public.studio_brand_v3(p_organization_id uuid,p_task_id uuid,p_expected_revision integer,p_brand jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.work_tasks%rowtype;b public.studio_client_brands_v3%rowtype;
begin
 if not public.studio_task_access_v2(p_organization_id,p_task_id) or not public.has_org_capability(p_organization_id,'clients.manage') then raise exception using errcode='42501',message='client_manage_required';end if;
 if jsonb_typeof(p_brand) is distinct from 'object' or octet_length(p_brand::text)>8192 or coalesce(p_brand->>'primary','') !~ '^#[A-Fa-f0-9]{6}$' or coalesce(p_brand->>'secondary','') !~ '^#[A-Fa-f0-9]{6}$' or coalesce(p_brand->>'accent','') !~ '^#[A-Fa-f0-9]{6}$' or coalesce(p_brand->>'font','') not in('Manrope','Readex Pro','Arial','Georgia') then raise exception 'studio_brand_invalid';end if;
 select * into t from public.work_tasks where id=p_task_id;
 if nullif(p_brand->>'logoId','') is not null and not exists(select 1 from public.task_document_links_v2 l join public.document_files f on f.id=l.document_id where l.task_id=t.id and l.organization_id=p_organization_id and f.id::text=p_brand->>'logoId' and f.mime_type like 'image/%' and f.deleted_at is null and f.status='ACTIVE' and public.can_read_document_v2(f.organization_id,f.visibility,f.legacy_client_id,f.employee_record_id)) then raise exception 'studio_brand_logo_invalid';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.client_account_id::text,0));
 select * into b from public.studio_client_brands_v3 where organization_id=p_organization_id and client_account_id=t.client_account_id for update;
 if p_expected_revision is distinct from coalesce(b.revision,0) then raise exception using errcode='PT409',message='studio_brand_conflict';end if;
 insert into public.studio_client_brands_v3(organization_id,client_account_id,revision,brand,updated_by) values(p_organization_id,t.client_account_id,coalesce(b.revision,0)+1,p_brand,auth.uid()) on conflict(organization_id,client_account_id) do update set revision=excluded.revision,brand=excluded.brand,updated_by=excluded.updated_by,updated_at=now();
 return public.studio_resources_v3(p_organization_id,p_task_id);
end;$$;
create function public.studio_template_v3(p_organization_id uuid,p_task_id uuid,p_title text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.studio_task_access_v2(p_organization_id,p_task_id) then raise exception using errcode='42501',message='studio_access_required';end if;
 if char_length(btrim(p_title)) not between 2 and 120 or not coalesce(public.studio_builder_valid_v3(p_payload),false) then raise exception 'studio_template_invalid';end if;
 insert into public.studio_templates_v3(organization_id,task_id,title,payload,created_by) values(p_organization_id,p_task_id,btrim(p_title),p_payload,auth.uid());return public.studio_resources_v3(p_organization_id,p_task_id);
end;$$;
create function public.studio_share_v3(p_organization_id uuid,p_document_id uuid,p_action text,p_share_id uuid default null,p_review boolean default false,p_days integer default 7) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.studio_documents_v2%rowtype;v public.studio_versions_v2%rowtype;token text;sid uuid;output jsonb;
begin
 select * into d from public.studio_documents_v2 where id=p_document_id and organization_id=p_organization_id;
 if d.id is null or not public.studio_task_access_v2(p_organization_id,d.task_id) or not public.has_org_capability(p_organization_id,'documents.manage') then raise exception using errcode='42501',message='studio_share_permission_required';end if;
 if p_action in('REVOKE','REGENERATE') then update public.studio_shares_v3 set revoked_at=now() where id=p_share_id and document_id=d.id and organization_id=p_organization_id;if not found then raise exception 'studio_share_not_found';end if;end if;
 if p_action in('CREATE','REGENERATE') then
  if p_days not between 1 and 90 or p_days is null then raise exception 'studio_share_expiry_invalid';end if;
  select * into v from public.studio_versions_v2 where document_id=d.id and revision=d.revision;
  if not coalesce(public.studio_builder_valid_v3(v.payload),false) then raise exception 'studio_builder_required';end if;
  if exists(select 1 from jsonb_array_elements(v.payload->'pages') p cross join lateral jsonb_array_elements(p->'blocks') b where nullif(b->>'mediaId','') is not null and not exists(select 1 from public.task_document_links_v2 l join public.document_files f on f.id=l.document_id where l.task_id=d.task_id and l.organization_id=p_organization_id and f.id::text=b->>'mediaId' and f.mime_type like 'image/%' and f.deleted_at is null and f.status='ACTIVE' and public.can_read_document_v2(f.organization_id,f.visibility,f.legacy_client_id,f.employee_record_id))) then raise exception 'studio_shared_image_invalid';end if;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.studio_shares_v3(organization_id,document_id,revision,token_hash,payload,allow_review,expires_at,created_by) values(p_organization_id,d.id,d.revision,encode(extensions.digest(token,'sha256'),'hex'),v.payload-'binding',coalesce(p_review,false),now()+make_interval(days=>p_days),auth.uid()) returning id into sid;
 elsif p_action not in('REVOKE','LIST') then raise exception 'studio_share_action_invalid';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'revision',s.revision,'review',s.allow_review,'expiresAt',s.expires_at,'revokedAt',s.revoked_at,'createdAt',s.created_at,'lastViewedAt',s.last_viewed_at) order by s.created_at desc),'[]') into output from public.studio_shares_v3 s where s.document_id=d.id;
 return jsonb_build_object('ok',true,'token',token,'id',sid,'shares',output);
end;$$;
create function public.studio_share_live_v3(p_organization_id uuid,p_actor_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.organizations o join public.organization_members m on m.organization_id=o.id join public.role_capabilities rc on rc.role_id=m.role_id join public.capabilities c on c.id=rc.capability_id join public.profiles p on p.id=m.user_id where o.id=p_organization_id and o.status='ACTIVE' and o.deleted_at is null and m.user_id=p_actor_id and m.status='ACTIVE' and p.identity_status='ACTIVE' and c.key='documents.manage');
$$;
revoke all on function public.studio_share_live_v3(uuid,uuid) from public,anon,authenticated;
create function public.studio_shared_v3(p_token text,p_action text default 'VIEW',p_body text default null,p_name text default null,p_page_id text default null,p_block_id text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.studio_shares_v3%rowtype;
begin
 if coalesce(p_token,'') !~ '^[a-f0-9]{64}$' then raise exception using errcode='42501',message='share_unavailable';end if;
 select * into s from public.studio_shares_v3 where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
 if s.id is null or s.revoked_at is not null or s.expires_at<=now() or not public.studio_share_live_v3(s.organization_id,s.created_by) then raise exception using errcode='42501',message='share_unavailable';end if;
 if p_action='VIEW' then update public.studio_shares_v3 set last_viewed_at=now() where id=s.id;
 elsif p_action in('COMMENT','APPROVE','CHANGES') and s.allow_review then
  if char_length(btrim(coalesce(p_body,''))) not between 1 and 2000 or char_length(btrim(coalesce(p_name,''))) not between 1 and 120 then raise exception 'review_message_required';end if;
  if (select count(*) from public.studio_comments_v3 where share_id=s.id and created_at>now()-interval '1 minute')>=10 then raise exception 'review_rate_limited';end if;
  if (p_block_id is not null and p_page_id is null) or p_page_id is not null and not exists(select 1 from jsonb_array_elements(s.payload->'pages') p where p->>'id'=p_page_id and (p_block_id is null or exists(select 1 from jsonb_array_elements(p->'blocks') b where b->>'id'=p_block_id))) then raise exception 'review_target_invalid';end if;
  insert into public.studio_comments_v3(organization_id,document_id,revision,page_id,block_id,body,decision,share_id,reviewer_name) values(s.organization_id,s.document_id,s.revision,p_page_id,p_block_id,btrim(p_body),p_action,s.id,btrim(p_name));
 else raise exception using errcode='42501',message='share_read_only';end if;
 return jsonb_build_object('ok',true,'title',s.payload->>'title','revision',s.revision,'payload',s.payload,'allowReview',s.allow_review,'expiresAt',s.expires_at);
end;$$;
create function public.studio_comments_v3(p_organization_id uuid,p_document_id uuid,p_body text default null,p_page_id text default null,p_block_id text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.studio_documents_v2%rowtype;payload jsonb;result jsonb;
begin
 select * into d from public.studio_documents_v2 where id=p_document_id and organization_id=p_organization_id;
 if d.id is null or not public.studio_task_access_v2(p_organization_id,d.task_id) then raise exception using errcode='42501',message='studio_access_required';end if;
 if p_body is not null then
  if char_length(btrim(p_body)) not between 1 and 2000 then raise exception 'review_message_required';end if;
  select v.payload into payload from public.studio_versions_v2 v where v.document_id=d.id and v.revision=d.revision;
  if (p_block_id is not null and p_page_id is null) or p_page_id is not null and not exists(select 1 from jsonb_array_elements(payload->'pages') p where p->>'id'=p_page_id and (p_block_id is null or exists(select 1 from jsonb_array_elements(p->'blocks') b where b->>'id'=p_block_id))) then raise exception 'review_target_invalid';end if;
  insert into public.studio_comments_v3(organization_id,document_id,revision,page_id,block_id,body,decision,actor_id) values(d.organization_id,d.id,d.revision,p_page_id,p_block_id,btrim(p_body),'COMMENT',auth.uid());
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'revision',c.revision,'pageId',c.page_id,'blockId',c.block_id,'body',c.body,'decision',c.decision,'external',c.share_id is not null,'reviewerName',c.reviewer_name,'createdAt',c.created_at) order by c.created_at),'[]') into result from public.studio_comments_v3 c where c.document_id=d.id;return jsonb_build_object('ok',true,'comments',result);
end;$$;
create function public.studio_shared_asset_v3(p_token text,p_file_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.studio_shares_v3%rowtype;f public.document_files%rowtype;t uuid;
begin
 if coalesce(p_token,'') !~ '^[a-f0-9]{64}$' then raise exception using errcode='42501',message='share_unavailable';end if;
 select * into s from public.studio_shares_v3 where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and revoked_at is null and expires_at>now();
 if s.id is null or not public.studio_share_live_v3(s.organization_id,s.created_by) or not exists(select 1 from jsonb_array_elements(s.payload->'pages') p cross join lateral jsonb_array_elements(p->'blocks') b where b->>'mediaId'=p_file_id::text) then raise exception using errcode='42501',message='share_unavailable';end if;
 select task_id into t from public.studio_documents_v2 where id=s.document_id;
 select df.* into f from public.document_files df join public.task_document_links_v2 l on l.document_id=df.id where l.task_id=t and l.organization_id=s.organization_id and df.id=p_file_id and df.deleted_at is null and df.status='ACTIVE' and df.mime_type like 'image/%';
 if f.id is null then raise exception using errcode='42501',message='share_unavailable';end if;
 return jsonb_build_object('bucket',f.bucket,'path',coalesce(f.optimized_path,f.original_path),'expiresIn',greatest(1,least(60,extract(epoch from s.expires_at-now())::integer)));
end;$$;
revoke all on function public.studio_shared_asset_v3(text,uuid) from public,anon,authenticated;
grant execute on function public.studio_shared_asset_v3(text,uuid) to service_role;
revoke all on function public.studio_builder_valid_v3(jsonb),public.studio_builder_guard_v3(),public.studio_resources_v3(uuid,uuid),public.studio_brand_v3(uuid,uuid,integer,jsonb),public.studio_template_v3(uuid,uuid,text,jsonb),public.studio_share_v3(uuid,uuid,text,uuid,boolean,integer),public.studio_shared_v3(text,text,text,text,text,text),public.studio_comments_v3(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.studio_resources_v3(uuid,uuid),public.studio_brand_v3(uuid,uuid,integer,jsonb),public.studio_template_v3(uuid,uuid,text,jsonb),public.studio_share_v3(uuid,uuid,text,uuid,boolean,integer),public.studio_comments_v3(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.studio_shared_v3(text,text,text,text,text,text) to anon,authenticated;
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
    'video/mp4','video/webm','application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
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
update storage.buckets set allowed_mime_types=array(select distinct unnest(coalesce(allowed_mime_types,array[]::text[])||array['video/mp4','video/webm'])) where id='magnet-documents';
commit;
