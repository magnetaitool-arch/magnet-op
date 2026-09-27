-- Approved Studio content sources retain task, client and tenant authorization.
-- No legacy Calendar permissions or business rows are changed.
begin;
create or replace function public.studio_resources_v3(p_organization_id uuid,p_task_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t public.work_tasks%rowtype;kit jsonb;templates jsonb;
begin
 if not public.studio_task_access_v2(p_organization_id,p_task_id) then raise exception using errcode='42501',message='studio_access_required';end if;
 select * into t from public.work_tasks where id=p_task_id;
 select jsonb_build_object('revision',b.revision,'brand',b.brand) into kit from public.studio_client_brands_v3 b where b.organization_id=p_organization_id and b.client_account_id=t.client_account_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'payload',x.payload) order by x.created_at desc),'[]') into templates from public.studio_templates_v3 x join public.work_tasks xt on xt.id=x.task_id where x.organization_id=p_organization_id and xt.client_account_id=t.client_account_id and public.studio_task_access_v2(p_organization_id,xt.id);
 return jsonb_build_object('ok',true,'kit',kit,'templates',templates,'canManageBrand',public.has_org_capability(p_organization_id,'clients.manage'),'canShare',public.has_org_capability(p_organization_id,'documents.manage'),
 'sources',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'type',r.coll,'title',coalesce(r.data->>'title',r.data->>'name'),'summary',coalesce(r.data->>'executiveSummary',r.data->>'scope',r.data->>'caption',r.data->>'objective'),'metrics',r.data->>'kpiSummary','recommendations',r.data->>'recommendations','nextPlan',r.data->>'nextPlan','service',r.data->>'serviceType','price',r.data->>'price','currency',r.data->>'currency','timeline',coalesce(r.data->>'timeline',r.data->>'scheduledDate'),'status',r.data->>'status') order by r.id) from public.records r where r.organization_id=p_organization_id and r.coll in('proposals','reports','contentCalendar','briefs','campaigns') and r.deleted_at is null and r.data->>'clientId'=t.legacy_client_id and public.records_can_read(r.organization_id,r.coll,r.data) and (r.coll<>'reports' or coalesce(r.data->>'reportKind','Client')='Client') and (r.coll<>'contentCalendar' or r.data->>'approvalStatus'='Approved' or r.data->>'status'='Approved')),'[]'::jsonb) || coalesce((select jsonb_agg(jsonb_build_object(
  'id',d.id,'type','studio_content','title',v.payload->>'title',
  'summary',v.payload->>'body','revision',d.revision,'status',d.status) order by d.id)
 from public.studio_documents_v2 d
 join public.work_tasks wt on wt.id=d.task_id and wt.organization_id=d.organization_id
 join public.studio_versions_v2 v on v.document_id=d.id and v.revision=d.revision
 where d.organization_id=p_organization_id and wt.client_account_id=t.client_account_id
 and d.kind='content' and d.status in('APPROVED','FINAL')
 and public.studio_task_access_v2(p_organization_id,wt.id)), '[]'::jsonb));
end;$$;

commit;
