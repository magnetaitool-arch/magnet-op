-- A client logo may be inherited across that client's task documents.
-- No browser grants change; share creation still checks user file-read permission.
begin;
create function public.studio_client_image_relation_v3(p_org uuid,p_task uuid,p_file text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.work_tasks target
 join public.work_tasks source on source.organization_id=target.organization_id and source.client_account_id=target.client_account_id
 join public.task_document_links_v2 l on l.organization_id=source.organization_id and l.task_id=source.id
 join public.document_files f on f.organization_id=l.organization_id and f.id=l.document_id
 where target.id=p_task and target.organization_id=p_org and f.id::text=p_file
 and f.deleted_at is null and f.status='ACTIVE' and f.mime_type like 'image/%');
$$;
revoke all on function public.studio_client_image_relation_v3(uuid,uuid,text) from public,anon,authenticated;
create or replace function public.studio_share_v3(p_organization_id uuid,p_document_id uuid,p_action text,p_share_id uuid default null,p_review boolean default false,p_days integer default 7) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.studio_documents_v2%rowtype;v public.studio_versions_v2%rowtype;token text;sid uuid;output jsonb;
begin
 select * into d from public.studio_documents_v2 where id=p_document_id and organization_id=p_organization_id;
 if d.id is null or not public.studio_task_access_v2(p_organization_id,d.task_id) or not public.has_org_capability(p_organization_id,'documents.manage') then raise exception using errcode='42501',message='studio_share_permission_required';end if;
 if p_action in('REVOKE','REGENERATE') then update public.studio_shares_v3 set revoked_at=now() where id=p_share_id and document_id=d.id and organization_id=p_organization_id;if not found then raise exception 'studio_share_not_found';end if;end if;
 if p_action in('CREATE','REGENERATE') then
  if p_days not between 1 and 90 or p_days is null then raise exception 'studio_share_expiry_invalid';end if;
  select * into v from public.studio_versions_v2 where document_id=d.id and revision=d.revision;
  if not coalesce(public.studio_builder_valid_v3(v.payload),false) then raise exception 'studio_builder_required';end if;
  if exists(select 1 from jsonb_array_elements(v.payload->'pages') p cross join lateral jsonb_array_elements(p->'blocks') b where nullif(b->>'mediaId','') is not null and not exists(select 1 from public.task_document_links_v2 l join public.document_files f on f.id=l.document_id where (l.task_id=d.task_id or (b->>'type' in('cover','logo') and b->>'mediaId'=v.payload#>>'{brand,logoId}' and public.studio_client_image_relation_v3(p_organization_id,d.task_id,b->>'mediaId'))) and l.organization_id=p_organization_id and f.id::text=b->>'mediaId' and f.mime_type like 'image/%' and f.deleted_at is null and f.status='ACTIVE' and public.can_read_document_v2(f.organization_id,f.visibility,f.legacy_client_id,f.employee_record_id))) then raise exception 'studio_shared_image_invalid';end if;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.studio_shares_v3(organization_id,document_id,revision,token_hash,payload,allow_review,expires_at,created_by) values(p_organization_id,d.id,d.revision,encode(extensions.digest(token,'sha256'),'hex'),v.payload-'binding',coalesce(p_review,false),now()+make_interval(days=>p_days),auth.uid()) returning id into sid;
 elsif p_action not in('REVOKE','LIST') then raise exception 'studio_share_action_invalid';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'revision',s.revision,'review',s.allow_review,'expiresAt',s.expires_at,'revokedAt',s.revoked_at,'createdAt',s.created_at,'lastViewedAt',s.last_viewed_at) order by s.created_at desc),'[]') into output from public.studio_shares_v3 s where s.document_id=d.id;
 return jsonb_build_object('ok',true,'token',token,'id',sid,'shares',output);
end;$$;
create or replace function public.studio_shared_asset_v3(p_token text,p_file_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.studio_shares_v3%rowtype;f public.document_files%rowtype;t uuid;
begin
 if coalesce(p_token,'') !~ '^[a-f0-9]{64}$' then raise exception using errcode='42501',message='share_unavailable';end if;
 select * into s from public.studio_shares_v3 where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and revoked_at is null and expires_at>now();
 if s.id is null or not public.studio_share_live_v3(s.organization_id,s.created_by) or not exists(select 1 from jsonb_array_elements(s.payload->'pages') p cross join lateral jsonb_array_elements(p->'blocks') b where b->>'mediaId'=p_file_id::text) then raise exception using errcode='42501',message='share_unavailable';end if;
 select task_id into t from public.studio_documents_v2 where id=s.document_id;
 select df.* into f from public.document_files df join public.task_document_links_v2 l on l.document_id=df.id where (l.task_id=t or (p_file_id::text=s.payload#>>'{brand,logoId}' and public.studio_client_image_relation_v3(s.organization_id,t,p_file_id::text))) and l.organization_id=s.organization_id and df.id=p_file_id and df.deleted_at is null and df.status='ACTIVE' and df.mime_type like 'image/%';
 if f.id is null then raise exception using errcode='42501',message='share_unavailable';end if;
 return jsonb_build_object('bucket',f.bucket_id,'path',coalesce(f.optimized_path,f.original_path),'expiresIn',greatest(1,least(60,extract(epoch from s.expires_at-now())::integer)));
end;$$;
commit;
