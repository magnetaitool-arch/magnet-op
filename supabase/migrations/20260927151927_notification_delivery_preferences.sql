-- Additive delivery foundation. Existing business records are not rewritten.
begin;
create table public.notification_preferences_v2 (
 organization_id uuid not null, user_id uuid not null,
 category text not null check(category in ('assignments','mentions','approvals','revisions','deadlines','leads','proposals','publishing','security')),
 email_enabled boolean not null default true, updated_at timestamptz not null default now(),
 primary key(organization_id,user_id,category),
 foreign key(organization_id,user_id) references public.organization_members(organization_id,user_id) on delete restrict
);
alter table public.notification_preferences_v2 enable row level security;
revoke all on public.notification_preferences_v2 from public,anon,authenticated;
create policy notification_preferences_self on public.notification_preferences_v2 for select to authenticated
 using(user_id=auth.uid() and public.is_active_org_member(organization_id));
grant select on public.notification_preferences_v2 to authenticated;
grant all on public.notification_preferences_v2 to service_role;
create function public.notification_preferences_v2(p_organization_id uuid,p_category text default null,p_enabled boolean default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='active_membership_required'; end if;
 if p_category is not null then
  if p_category not in ('assignments','mentions','approvals','revisions','deadlines','leads','proposals','publishing','security') or p_enabled is null then raise exception using errcode='22023',message='invalid_preference'; end if;
  if p_category='security' and not p_enabled then raise exception using errcode='22023',message='security_email_required'; end if;
  insert into public.notification_preferences_v2(organization_id,user_id,category,email_enabled)
  values(p_organization_id,auth.uid(),p_category,p_enabled)
  on conflict(organization_id,user_id,category) do update set email_enabled=excluded.email_enabled,updated_at=now();
 end if;
 return (select jsonb_object_agg(category,coalesce((select email_enabled from public.notification_preferences_v2 p where p.organization_id=p_organization_id and p.user_id=auth.uid() and p.category=c.category),true))
 from unnest(array['assignments','mentions','approvals','revisions','deadlines','leads','proposals','publishing','security']) c(category));
end $$;
revoke all on function public.notification_preferences_v2(uuid,text,boolean) from public,anon;
grant execute on function public.notification_preferences_v2(uuid,text,boolean) to authenticated;

create function public.notification_email_category_v2(p_type text) returns text language sql immutable set search_path='' as $$
 select case
 when p_type in ('SECURITY_EVENT','TEAM_INVITATION','WELCOME') then 'security'
 when p_type like '%MENTION%' then 'mentions'
 when p_type like '%REVISION%' then 'revisions'
 when p_type like '%APPROVAL%' then 'approvals'
 when p_type like '%FOLLOWUP%' or p_type like '%DEADLINE%' then 'deadlines'
 when p_type like '%LEAD%' then 'leads'
 when p_type like '%PROPOSAL%' then 'proposals'
 when p_type='PUBLISHING_FAILED' then 'publishing'
 when p_type in ('TASK_ASSIGNED','TASK_ASSIGNMENT') then 'assignments'
 else null end
$$;
create function public.queue_notification_email_v2() returns trigger language plpgsql security definer set search_path='' as $$
declare email_category text:=public.notification_email_category_v2(new.notification_type); recipient text;
begin
 if email_category is null or (new.expires_at is not null and new.expires_at<=now()) then return new; end if;
 if email_category<>'security' and exists(select 1 from public.notification_preferences_v2 p where p.organization_id=new.organization_id and p.user_id=new.recipient_user_id and p.category=email_category and not p.email_enabled) then return new; end if;
 select p.email_normalized into recipient from public.profiles p
 join public.organization_members m on m.user_id=p.id and m.organization_id=new.organization_id
 join public.organizations o on o.id=m.organization_id
 where p.id=new.recipient_user_id and p.identity_status='ACTIVE' and m.status='ACTIVE' and o.status='ACTIVE' and o.deleted_at is null;
 if recipient is null or recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return new; end if;
 insert into public.outbox_messages(organization_id,kind,recipient_ref,payload,idempotency_key)
 values(new.organization_id,'EMAIL_NOTIFICATION',new.recipient_user_id::text,jsonb_build_object(
 'to',jsonb_build_array(recipient),'eventType',new.notification_type,'category',email_category,'title',new.title,'message',new.message,
 'route',new.route,'entityType',new.entity_type,'entityId',new.entity_id,'notificationId',new.id,'recipientUserId',new.recipient_user_id), 'notification:'||new.id)
 on conflict(organization_id,kind,idempotency_key) do nothing;
 return new;
end $$;
revoke all on function public.queue_notification_email_v2() from public,anon,authenticated;
create trigger notification_email_v2 after insert on public.user_notifications_v2 for each row execute function public.queue_notification_email_v2();

-- Verified provider receipts contain metadata only, never email bodies/addresses.
create table public.email_provider_events_v2 (
 event_id text primary key check(char_length(event_id) between 1 and 200),
 provider_message_id text not null,event_type text not null,
 occurred_at timestamptz not null,received_at timestamptz not null default now()
);
alter table public.email_provider_events_v2 enable row level security;
revoke all on public.email_provider_events_v2 from public,anon,authenticated;
grant select,insert on public.email_provider_events_v2 to service_role;
create index email_provider_events_message_idx on public.email_provider_events_v2(provider_message_id,occurred_at);
alter table public.outbox_messages add column provider_event_at timestamptz;
alter table public.outbox_messages drop constraint outbox_messages_status_check;
alter table public.outbox_messages add constraint outbox_messages_status_check check(status in ('PENDING','PROCESSING','ACCEPTED','DELIVERED','FAILED','SUPPRESSED','CANCELLED','BOUNCED'));
create index outbox_provider_message_idx on public.outbox_messages(provider_message_id) where provider_message_id is not null;
create function public.apply_resend_event_v2(p_event_id text,p_provider_id text,p_event_type text,p_occurred_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_event_type not in ('email.sent','email.delivered','email.bounced','email.complained','email.failed','email.delivery_delayed') or p_occurred_at is null or p_provider_id is null then raise exception using errcode='22023',message='invalid_event'; end if;
 insert into public.email_provider_events_v2(event_id,provider_message_id,event_type,occurred_at) values(p_event_id,p_provider_id,p_event_type,p_occurred_at) on conflict(event_id) do nothing;
 -- Replays also reconcile receipts which arrived before the worker saved provider ID.
 update public.outbox_messages set provider_event_at=p_occurred_at,
 provider_status=p_event_type,
 status=case when p_event_type='email.bounced' then 'BOUNCED' when p_event_type='email.complained' then 'SUPPRESSED' when p_event_type='email.delivered' then 'DELIVERED' when p_event_type='email.failed' then 'FAILED' else status end,
 delivered_at=case when p_event_type='email.delivered' then p_occurred_at else delivered_at end,
 last_error_category=case when p_event_type in ('email.bounced','email.complained','email.failed') then upper(replace(p_event_type,'.','_')) else last_error_category end,
 next_attempt_at='infinity'::timestamptz
 where provider_message_id=p_provider_id and kind like 'EMAIL_%'
 and (provider_event_at is null or provider_event_at<p_occurred_at)
 and status not in ('BOUNCED','SUPPRESSED','CANCELLED')
 and not (status='DELIVERED' and p_event_type in ('email.sent','email.failed','email.delivery_delayed'));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.apply_resend_event_v2(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.apply_resend_event_v2(text,text,text,timestamptz) to service_role;
-- Preserve lease/attempt implementation while preventing unsafe retry transitions.
create function public.guard_email_delivery_v2() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.kind not like 'EMAIL_%' then return new; end if;
 new.max_attempts:=least(new.max_attempts,20);
 if new.status='PENDING' and old.status<>'PENDING' then
  if old.status<>'FAILED' or old.provider_message_id is not null or old.attempt_count>=20 or old.last_error_category in ('PROVIDER_PERMANENT','EMAIL_BOUNCED','EMAIL_COMPLAINED','EMAIL_FAILED','IDEMPOTENCY_WINDOW_EXPIRED') then
   raise exception using errcode='22023',message='delivery_not_retryable';
  end if;
 end if;
 if new.status='FAILED' and new.last_error_category in ('PROVIDER_PERMANENT','CONFIGURATION_MISSING','IDEMPOTENCY_WINDOW_EXPIRED') then new.next_attempt_at:='infinity'::timestamptz; end if;
 return new;
end $$;
revoke all on function public.guard_email_delivery_v2() from public,anon,authenticated;
create trigger guard_email_delivery_v2 before update on public.outbox_messages for each row execute function public.guard_email_delivery_v2();
-- Reconcile a webhook that beat the provider response to the database.
create function public.reconcile_resend_receipts_v2() returns trigger language plpgsql security definer set search_path='' as $$
declare receipt record;
begin
 for receipt in select * from public.email_provider_events_v2 where provider_message_id=new.provider_message_id order by occurred_at,event_id loop
  perform public.apply_resend_event_v2(receipt.event_id,receipt.provider_message_id,receipt.event_type,receipt.occurred_at);
 end loop;
 return new;
end $$;
revoke all on function public.reconcile_resend_receipts_v2() from public,anon,authenticated;
create trigger reconcile_resend_receipts_v2 after update of provider_message_id on public.outbox_messages
 for each row when(new.provider_message_id is not null and old.provider_message_id is distinct from new.provider_message_id)
 execute function public.reconcile_resend_receipts_v2();
-- Permission/preferences are rechecked at send time, not just when queued.
create function public.notification_email_allowed_v2(p_message_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.outbox_messages q
 join public.organization_members m on m.organization_id=q.organization_id and m.user_id::text=q.payload->>'recipientUserId'
 join public.profiles p on p.id=m.user_id join public.organizations o on o.id=m.organization_id
 where q.id=p_message_id and q.kind='EMAIL_NOTIFICATION' and m.status='ACTIVE' and p.identity_status='ACTIVE' and o.status='ACTIVE' and o.deleted_at is null
 and p.email_normalized=q.payload->'to'->>0
 and (q.payload->>'category'='security' or not exists(select 1 from public.notification_preferences_v2 pref where pref.organization_id=m.organization_id and pref.user_id=m.user_id and pref.category=q.payload->>'category' and not pref.email_enabled)))
$$;
revoke all on function public.notification_email_allowed_v2(uuid) from public,anon,authenticated;
grant execute on function public.notification_email_allowed_v2(uuid) to service_role;
create function public.email_delivery_log_v2(p_organization_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.has_org_capability(p_organization_id,'organization.manage') then raise exception using errcode='42501',message='organization_manage_required'; end if;
 return jsonb_build_object('ok',true,'messages',coalesce((select jsonb_agg(to_jsonb(x)) from (
 select id,kind,payload->>'eventType' as event_type,payload->'to' as recipient,payload->>'entityType' as entity_type,payload->>'entityId' as entity_id,
 provider_message_id,case status when 'PENDING' then 'QUEUED' when 'PROCESSING' then 'SENDING' when 'ACCEPTED' then 'SENT' else status end as status,
 attempt_count,last_error_category,created_at,last_attempt_at,delivered_at,provider_status from public.outbox_messages where organization_id=p_organization_id and kind like 'EMAIL_%' order by created_at desc limit 50
 ) x),'[]'::jsonb));
end $$;
revoke all on function public.email_delivery_log_v2(uuid) from public,anon;
grant execute on function public.email_delivery_log_v2(uuid) to authenticated;

commit;
