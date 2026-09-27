begin;
create function public.acquisition_metrics_v2(p_organization_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='sales_read_required'; end if;
 return jsonb_build_object(
 'newLeads',(select count(*) from public.crm_leads where organization_id=p_organization_id and deleted_at is null and stage='New Lead'),
 'leadsToday',(select count(*) from public.crm_leads where organization_id=p_organization_id and deleted_at is null and submitted_at>=date_trunc('day',now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'),
 'websiteLeads',(select count(distinct lead_id) from public.website_lead_receipts_v2 where organization_id=p_organization_id and created_at>=now()-interval '30 days'),
 'followupsToday',(select count(*) from public.crm_followups_v2 where organization_id=p_organization_id and status='OPEN' and (due_at at time zone 'Africa/Cairo')::date=(now() at time zone 'Africa/Cairo')::date),
 'overdueFollowups',(select count(*) from public.crm_followups_v2 where organization_id=p_organization_id and status='OPEN' and due_at<now()),
 'proposalsPending',(select count(*) from public.records where organization_id=p_organization_id and coll='proposals' and deleted_at is null and data->>'status' in ('Sent','Pending','Under Review')),
 'negotiations',(select count(*) from public.crm_leads where organization_id=p_organization_id and deleted_at is null and stage='Negotiation'),
 'won',(select count(*) from public.crm_leads where organization_id=p_organization_id and deleted_at is null and stage='Won'),
 'lost',(select count(*) from public.crm_leads where organization_id=p_organization_id and deleted_at is null and stage='Lost'),
 'sources',coalesce((select jsonb_agg(to_jsonb(x)) from (select coalesce(nullif(payload->>'utm_source',''),source,'Unknown') source,count(*) leads,count(*) filter(where stage='Won') won
 from public.crm_leads where organization_id=p_organization_id and deleted_at is null and submitted_at>=now()-interval '30 days' group by 1 order by 2 desc limit 20) x),'[]'::jsonb));
end $$;
revoke all on function public.acquisition_metrics_v2(uuid) from public,anon;
grant execute on function public.acquisition_metrics_v2(uuid) to authenticated;
commit;
