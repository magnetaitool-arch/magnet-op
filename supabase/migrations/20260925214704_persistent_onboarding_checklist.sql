-- Preserve existing client checklist data; initialize only on an explicit first save.
begin;
create table public.client_onboarding_commands_v2(
 organization_id uuid not null references public.organizations(id) on delete restrict,
 command_id uuid not null,actor_user_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,created_at timestamptz not null default now(),primary key(organization_id,command_id)
);
alter table public.client_onboarding_commands_v2 enable row level security;
revoke all on public.client_onboarding_commands_v2 from public,anon,authenticated;
grant select,insert on public.client_onboarding_commands_v2 to service_role;
create or replace function public.get_client_onboarding_v2(p_organization_id uuid,p_client_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.records%rowtype;items jsonb;
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='onboarding_read_required';end if;
 select * into c from public.records where organization_id=p_organization_id and coll='clients' and id=p_client_id and deleted_at is null;
 if c.id is null or not exists(select 1 from public.client_accounts a where a.organization_id=p_organization_id and a.legacy_record_id=c.id and a.deleted_at is null and a.archived_at is null) then raise exception 'client_unavailable';end if;
 items=c.data->'onboarding';
 if items is null or items='[]'::jsonb then items='[{"item":"Contract signed","done":false},{"item":"Brief collected","done":false},{"item":"Brand assets received","done":false},{"item":"Kickoff meeting","done":false},{"item":"Credentials collected","done":false}]'::jsonb;end if;
 if jsonb_typeof(items)<>'array' then raise exception 'onboarding_data_review_required';end if;
 if jsonb_array_length(items)>100 or exists(select 1 from jsonb_array_elements(items) i where jsonb_typeof(i)<>'object' or jsonb_typeof(i->'item') is distinct from 'string'::text or char_length(btrim(coalesce(i->>'item',''))) not between 1 and 500 or jsonb_typeof(i->'done') is distinct from 'boolean'::text) then raise exception 'onboarding_data_review_required';end if;
 return jsonb_build_object('ok',true,'items',items,'version',encode(extensions.digest(items::text,'sha256'),'hex'),'canManage',public.has_org_capability(p_organization_id,'clients.manage'));
end;$$;
create or replace function public.set_client_onboarding_item_v2(p_organization_id uuid,p_client_id text,p_expected_version text,p_index integer,p_done boolean,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_view jsonb;items jsonb;updated jsonb;requested jsonb;prior public.client_onboarding_commands_v2%rowtype;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'clients.manage') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='onboarding_manage_required';end if;
 if p_command_id is null then raise exception 'command_id_required';end if;
 requested=jsonb_build_object('client',p_client_id,'version',p_expected_version,'index',p_index,'done',p_done);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into prior from public.client_onboarding_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then if prior.actor_user_id<>auth.uid() or prior.request<>requested then raise exception 'idempotency_conflict';end if;return public.get_client_onboarding_v2(p_organization_id,p_client_id)||jsonb_build_object('replayed',true);end if;
 perform 1 from public.records where organization_id=p_organization_id and id=p_client_id and coll='clients' and deleted_at is null for update;
 current_view=public.get_client_onboarding_v2(p_organization_id,p_client_id);items=current_view->'items';
 if p_index is null or p_index<0 or p_index>=jsonb_array_length(items) or p_done is null then raise exception 'onboarding_item_invalid';end if;
 if current_view->>'version' is distinct from p_expected_version then raise exception using errcode='40001',message='onboarding_version_conflict';end if;
 insert into public.client_onboarding_commands_v2 values(p_organization_id,p_command_id,auth.uid(),requested,now());
 if (items->p_index->>'done')::boolean=p_done then return current_view;end if;
 items=jsonb_set(items,array[p_index::text,'done'],to_jsonb(p_done),false);
 update public.records set data=data||jsonb_build_object('onboarding',items,'updatedAt',now()),updated_at=now(),updated_by=auth.uid()::text where id=p_client_id and organization_id=p_organization_id returning data||jsonb_build_object('id',id) into updated;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context)
 values(p_organization_id,auth.uid(),'CLIENT_ONBOARDING_CHECKED','client',p_client_id,jsonb_build_object('itemIndex',p_index,'done',p_done));
 return public.get_client_onboarding_v2(p_organization_id,p_client_id)||jsonb_build_object('client',updated);
end;$$;
revoke all on function public.get_client_onboarding_v2(uuid,text),public.set_client_onboarding_item_v2(uuid,text,text,integer,boolean,uuid) from public,anon;
grant execute on function public.get_client_onboarding_v2(uuid,text),public.set_client_onboarding_item_v2(uuid,text,text,integer,boolean,uuid) to authenticated;
commit;
-- Rollback application usage only. Preserve checklists and audit events.
