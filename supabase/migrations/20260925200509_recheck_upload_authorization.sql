-- Revalidate live membership, capability and visibility for every upload mutation.
-- No rows or objects are changed by this migration. See docs/AUTH_PROVISIONING_REPAIR.md.
begin;

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
  if not public.has_org_capability(p_organization_id,'documents.manage') then
    raise exception using errcode='42501',message='documents_manage_required'; end if;
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.deleted_at is null for update;
  if document_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if document_row.status<>'UPLOADING' then return jsonb_build_object('ok',false,'error','invalid_state'); end if;
  if not public.can_read_document_v2(document_row.organization_id,document_row.visibility,document_row.legacy_client_id,document_row.employee_record_id) then
    raise exception using errcode='42501',message='document_access_required'; end if;
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
  if not public.has_org_capability(p_organization_id,'documents.manage') then
    raise exception using errcode='42501',message='documents_manage_required'; end if;
  select * into document_row from public.document_files document
  where document.organization_id=p_organization_id and document.id=p_document_id and document.status='UPLOADING' for update;
  if document_row.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  if not public.can_read_document_v2(document_row.organization_id,document_row.visibility,document_row.legacy_client_id,document_row.employee_record_id) then
    raise exception using errcode='42501',message='document_access_required'; end if;
  update public.document_files set status='FAILED',updated_at=now(),version=version+1 where id=document_row.id;
  insert into public.document_events(organization_id,document_id,action,actor_user_id)
  values(p_organization_id,document_row.id,'UPLOAD_FAILED',auth.uid());
  return jsonb_build_object('ok',true,'status','FAILED');
end;
$$;

commit;
