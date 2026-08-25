-- M10 repair: align global search with the canonical CRM, client, finance and
-- contract column names. The original M10 migration is already applied on
-- Staging and remains immutable.

begin;

create or replace function public.global_search_v2(p_organization_id uuid,p_query text,p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q text:=btrim(coalesce(p_query,'')); declare result jsonb;
begin
  if not public.is_active_org_member(p_organization_id) then raise exception using errcode='42501',message='membership_required'; end if;
  if char_length(q)<2 then return jsonb_build_object('items','[]'::jsonb); end if;
  with candidates as (
    select 'task'::text kind,task.id::text id,task.title,task.task_code||' · '||task.status subtitle,'tasks'::text route,task.updated_at,
      case when lower(task.title) like lower(q)||'%' then 100 else 70 end rank
    from public.work_tasks task where task.organization_id=p_organization_id and task.deleted_at is null
      and public.can_read_task_v2(task.organization_id,task.legacy_client_id,task.assigned_user_id,task.assigned_employee_record_id,task.client_visible)
      and (task.title ilike '%'||q||'%' or task.task_code ilike '%'||q||'%')
    union all
    select 'client',client.legacy_record_id,client.display_name,coalesce(client.industry,'Client'),'clients',client.updated_at,
      case when lower(client.display_name) like lower(q)||'%' then 100 else 70 end
    from public.client_accounts client where client.organization_id=p_organization_id and client.deleted_at is null
      and public.has_org_capability(p_organization_id,'clients.read')
      and (public.current_member_role_key(p_organization_id)<>'client' or exists(select 1 from public.profiles profile where profile.id=auth.uid() and profile.client_id=client.legacy_record_id))
      and (client.display_name ilike '%'||q||'%' or coalesce(client.industry,'') ilike '%'||q||'%')
    union all
    select 'project',record.id,coalesce(record.data->>'projectName',record.data->>'name','Project'),coalesce(record.data->>'status','Project'),'projects',record.updated_at,70
    from public.records record where record.organization_id=p_organization_id and record.coll='projects' and record.deleted_at is null
      and public.records_can_read(record.organization_id,record.coll,record.data)
      and (coalesce(record.data->>'projectName','') ilike '%'||q||'%' or coalesce(record.data->>'name','') ilike '%'||q||'%')
    union all
    select 'lead',lead.legacy_record_id,lead.display_name,coalesce(lead.company_name,lead.stage),'leads',lead.updated_at,
      case when lower(lead.display_name) like lower(q)||'%' then 100 else 70 end
    from public.crm_leads lead where lead.organization_id=p_organization_id and lead.deleted_at is null
      and public.has_org_capability(p_organization_id,'clients.read') and public.current_member_role_key(p_organization_id)<>'client'
      and (lead.display_name ilike '%'||q||'%' or coalesce(lead.company_name,'') ilike '%'||q||'%' or coalesce(lead.phone,'') ilike '%'||q||'%')
    union all
    select 'contract',contract.legacy_record_id,contract.contract_number,contract.contract_type||' · '||contract.status,'contracts',contract.updated_at,70
    from public.agency_contracts contract where contract.organization_id=p_organization_id and contract.deleted_at is null
      and public.has_org_capability(p_organization_id,'clients.read')
      and (contract.contract_number ilike '%'||q||'%' or contract.contract_type ilike '%'||q||'%' or coalesce(contract.scope_summary,'') ilike '%'||q||'%')
    union all
    select 'invoice',invoice.legacy_record_id,invoice.invoice_number,invoice.stored_status||' · '||invoice.currency,'invoices',invoice.updated_at,70
    from public.finance_invoices invoice where invoice.organization_id=p_organization_id and invoice.deleted_at is null
      and public.has_org_capability(p_organization_id,'finance.read') and invoice.invoice_number ilike '%'||q||'%'
    union all
    select 'document',document.id::text,document.title,document.document_type,'documents',document.updated_at,70
    from public.document_files document where document.organization_id=p_organization_id and document.deleted_at is null and document.status in ('ACTIVE','ARCHIVED')
      and public.can_read_document_v2(document.organization_id,document.visibility,document.legacy_client_id,document.employee_record_id)
      and (document.title ilike '%'||q||'%' or coalesce(document.reference_number,'') ilike '%'||q||'%')
    union all
    select 'applicant',applicant.legacy_record_id,applicant.full_name,applicant.stage||' · Applicant','candidates',applicant.updated_at,70
    from public.applicants applicant where applicant.organization_id=p_organization_id and applicant.deleted_at is null
      and public.has_org_capability(p_organization_id,'hr.read') and (applicant.full_name ilike '%'||q||'%' or coalesce(applicant.position,'') ilike '%'||q||'%')
  ), limited as (select * from candidates order by rank desc,updated_at desc limit least(50,greatest(1,coalesce(p_limit,30))))
  select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'title',title,'subtitle',subtitle,'route',route) order by rank desc,updated_at desc),'[]'::jsonb) into result from limited;
  return jsonb_build_object('items',result);
end;
$$;

revoke all on function public.global_search_v2(uuid,text,integer) from public,anon;
grant execute on function public.global_search_v2(uuid,text,integer) to authenticated,service_role;

insert into public.migration_audit(migration,note) values(
  '20260826024500_repair_global_search_v2',
  'Aligned permission-aware global search with canonical V2 client, CRM lead, contract, and finance column names.'
);

commit;

-- Rollback: replace global_search_v2 with its prior definition. No data rows
-- are changed by this migration.
