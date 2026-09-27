begin;
alter table public.outbox_messages add column provider_idempotency_key text;
create function public.email_provider_key_v2() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.kind like 'EMAIL_%' and new.status='PROCESSING' and new.provider_idempotency_key is null then
  -- Preserve an earlier provider attempt's key; new messages use globally unique IDs.
  new.provider_idempotency_key:=case when old.attempt_count>0 then old.idempotency_key else 'magnet-outbox/'||new.id::text end;
 end if;
 return new;
end $$;
revoke all on function public.email_provider_key_v2() from public,anon,authenticated;
create trigger email_provider_key_v2 before update on public.outbox_messages for each row execute function public.email_provider_key_v2();
create function public.task_assignment_email_v2(p_organization_id uuid,p_legacy_record_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.has_org_capability(p_organization_id,'work.manage') then raise exception using errcode='42501',message='work_manage_required'; end if;
 select jsonb_build_object('ok',true,'id',q.id,'status',q.status,'error',q.last_error_category) into result
 from public.work_tasks t join public.user_notifications_v2 n on n.organization_id=t.organization_id and n.entity_id=t.id::text and n.notification_type='TASK_ASSIGNED'
 join public.outbox_messages q on q.organization_id=n.organization_id and q.payload->>'notificationId'=n.id::text and q.kind='EMAIL_NOTIFICATION'
 where t.organization_id=p_organization_id and t.legacy_record_id=p_legacy_record_id order by n.created_at desc limit 1;
 return coalesce(result,jsonb_build_object('ok',true,'status','NOT_QUEUED','reason','recipient_preference_or_no_assignment_event'));
end $$;
revoke all on function public.task_assignment_email_v2(uuid,text) from public,anon;
grant execute on function public.task_assignment_email_v2(uuid,text) to authenticated;
commit;
