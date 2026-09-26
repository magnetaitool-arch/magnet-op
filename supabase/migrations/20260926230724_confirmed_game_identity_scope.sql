-- Recognize a proven legacy account subject only for self-owned game rows.
-- No business rows or RLS policies are rewritten; existing policy guards remain.
-- Rollback: restore the previous records_can_write body, then drop this helper.
begin;
create function public.confirmed_game_subject_v3(p_org uuid,p_subject text)
returns boolean language sql stable security definer set search_path='' as $$
 select public.is_active_org_member(p_org) and nullif(p_subject,'') is not null
 and exists (
  select 1 from public.legacy_identity_links l
  join public.records a on a.id=l.legacy_account_row_id
  where l.auth_user_id=auth.uid() and l.link_status='CONFIRMED'
   and a.organization_id=p_org and a.coll='_accounts' and a.deleted_at is null
   and a.data->>'id'=p_subject and a.data->>'status'='Active'
 ) and not exists (
  select 1 from public.legacy_identity_links l
  join public.records a on a.id=l.legacy_account_row_id
  where l.auth_user_id is distinct from auth.uid() and l.link_status='CONFIRMED'
   and a.organization_id=p_org and a.coll='_accounts' and a.deleted_at is null
   and a.data->>'id'=p_subject
 );
$$;
revoke all on function public.confirmed_game_subject_v3(uuid,text) from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.records_can_write(p_organization_id uuid, p_collection text, p_data jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  member_role text;
begin
  if not public.is_active_org_member(p_organization_id) then return false; end if;
  if p_collection in ('_accounts', '_ratelimit', '_config') then return false; end if;

  member_role := public.current_member_role_key(p_organization_id);

  if p_collection = any (array[
    'clients','leads','contacts','salesActivities','proposals','quotations',
    'contracts','campaigns','briefs','packages','renewals'
  ]) then
    return public.has_org_capability(p_organization_id, 'clients.manage');
  end if;

  if p_collection = any (array[
    'projects','tasks','deliverables','clientAssets','files','revisions','meetings','plans'
  ]) then
    return public.has_org_capability(p_organization_id, 'work.manage');
  end if;

  if p_collection = any (array['chatMessages','comments']) then
    return public.has_org_capability(p_organization_id, 'work.manage')
      or (public.has_org_capability(p_organization_id, 'work.read') and public.record_matches_current_user(p_data));
  end if;

  if p_collection = 'approvalRequests' then
    return public.has_org_capability(p_organization_id, 'approvals.manage')
      or public.record_matches_current_user(p_data);
  end if;

  if p_collection = any (array['employees','candidates','freelancers','attendance','leaves','performanceReviews']) then
    return public.has_org_capability(p_organization_id, 'hr.manage')
      or (p_collection in ('attendance','leaves') and public.record_matches_current_user(p_data));
  end if;

  if p_collection = any (array[
    'invoices','payments','expenses','fixedCosts','partnerSettlements','collections','employeePayments'
  ]) then
    return public.has_org_capability(p_organization_id, 'finance.manage');
  end if;

  if p_collection = 'reports' then
    return public.has_org_capability(p_organization_id, 'reports.manage');
  end if;

  if p_collection = 'activityLogs' then return public.record_matches_current_user(p_data); end if;
  if p_collection = 'notifications' then return true; end if;
  if p_collection = any (array['gameScores','gameStats']) then return public.record_matches_current_user(p_data) or public.confirmed_game_subject_v3(p_organization_id,p_data->>'userId'); end if;
  if p_collection = any (array['departments','services']) then
    return public.has_org_capability(p_organization_id, 'organization.manage');
  end if;

  return false;
end;
$function$
;
commit;
