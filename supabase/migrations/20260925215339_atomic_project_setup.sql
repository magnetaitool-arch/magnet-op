-- Atomic replacement for project + optional task-template + draft-invoice browser writes.
-- No backfill or rewrite of existing projects, tasks or invoices.
begin;
create table public.project_setup_commands_v2(
 organization_id uuid not null references public.organizations(id) on delete restrict,
 command_id uuid not null,actor_user_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,result jsonb not null,created_at timestamptz not null default now(),primary key(organization_id,command_id)
);
alter table public.project_setup_commands_v2 enable row level security;
revoke all on public.project_setup_commands_v2 from public,anon,authenticated;
grant select,insert on public.project_setup_commands_v2 to service_role;
create table public.project_task_templates_v2(key text primary key,titles jsonb not null check(jsonb_typeof(titles)='array'));
revoke all on public.project_task_templates_v2 from public,anon,authenticated;
grant select,insert,update on public.project_task_templates_v2 to service_role;
insert into public.project_task_templates_v2(key,titles) values
('Social Media Management','["Receive client brief", "Create monthly content strategy", "Create content calendar", "Write captions", "Design posts", "Edit reels", "Internal review", "Send to client for approval", "Handle revisions", "Schedule posts", "Monthly report"]'::jsonb),
('Branding','["Discovery call", "Brand questionnaire", "Competitor research", "Moodboard", "Logo concepts", "Selected direction", "Brand identity system", "Brand guidelines", "Final files export", "Handover"]'::jsonb),
('Website / Landing Page','["Website brief", "Sitemap", "Wireframe", "Copywriting", "UI design", "Development", "Testing", "Client review", "Revisions", "Launch", "Handover"]'::jsonb),
('Ads Management','["Business manager access", "Pixel/tracking check", "Campaign strategy", "Audience research", "Creative requirements", "Campaign setup", "Daily monitoring", "Optimization", "Weekly report", "Monthly report"]'::jsonb),
('Production / Shooting','["Creative brief", "Shot list", "Location planning", "Talent/crew planning", "Shooting schedule", "Production day", "Footage backup", "Editing", "Internal review", "Client review", "Final export", "Delivery"]'::jsonb),
('Content Creation','["Receive brief", "Content plan", "Scripting", "Production", "Editing", "Internal review", "Client review", "Revisions", "Deliver"]'::jsonb),
('AI Content Production','["Brief & references", "Prompt design", "Generation batch", "Curation", "Editing/cleanup", "Internal review", "Client review", "Deliver"]'::jsonb),
('Marketing Consultation','["Discovery call", "Audit current state", "Research", "Strategy draft", "Internal review", "Present to client", "Final strategy doc", "Handover"]'::jsonb),
('Monthly Retainer','["Receive client brief", "Create monthly strategy", "Create content calendar", "Write captions", "Design posts", "Edit reels", "Internal review", "Send to client review", "Handle revisions", "Schedule content", "Monthly report"]'::jsonb),
('Campaign','["Campaign brief", "Concept", "Asset list", "Production", "Internal review", "Client approval", "Launch", "Monitor", "Wrap report"]'::jsonb),
('One-time Project','["Receive brief", "Plan", "Produce", "Internal review", "Client review", "Revisions", "Deliver"]'::jsonb);
create or replace function public.create_project_setup_v2(p_organization_id uuid,p_payload jsonb,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.project_setup_commands_v2%rowtype;c public.client_accounts%rowtype;project_id text;project_data jsonb;invoice_data jsonb;
 manager_record_id text;manager_user uuid;template_owner text;template_user uuid;start_day date;due_day date;budget numeric;titles jsonb;task_title text;task_result jsonb;task_data jsonb;changes jsonb:='[]'::jsonb;result jsonb;field text;invoice_id text;
begin
 if auth.uid() is null or not public.has_org_capability(p_organization_id,'work.manage') or not public.has_org_capability(p_organization_id,'clients.read') or public.current_member_role_key(p_organization_id)='client' then raise exception using errcode='42501',message='project_manage_required';end if;
 if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object'::text or octet_length(p_payload::text)>100000 then raise exception 'project_payload_invalid';end if;
 if exists(select 1 from jsonb_object_keys(p_payload) k where k not in('projectName','projectType','clientId','priority','objective','scope','brief','briefLink','referencesLinks','projectManagerId','accountManagerId','driveFolder','finalDeliveryFolder','notes','projectBudget','currency','startDate','deadline','status','createInvoice','createDefaultTasks','templateAssigneeId','brand')) then raise exception 'project_payload_field_unknown';end if;
 if (p_payload ? 'createInvoice' and jsonb_typeof(p_payload->'createInvoice')<>'boolean') or (p_payload ? 'createDefaultTasks' and jsonb_typeof(p_payload->'createDefaultTasks')<>'boolean') then raise exception 'project_options_invalid';end if;
 if coalesce(p_payload->>'createInvoice','false')='true' and not public.has_org_capability(p_organization_id,'finance.manage') then raise exception using errcode='42501',message='project_invoice_permission_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||p_command_id::text,0));
 select * into prior from public.project_setup_commands_v2 where organization_id=p_organization_id and command_id=p_command_id;
 if found then if prior.actor_user_id<>auth.uid() or prior.request<>p_payload then raise exception 'idempotency_conflict';end if;return prior.result||jsonb_build_object('replayed',true);end if;
 if char_length(btrim(coalesce(p_payload->>'projectName',''))) not between 2 and 240 or char_length(btrim(coalesce(p_payload->>'projectType','')))=0 then raise exception 'project_title_type_required';end if;
 if coalesce(p_payload->>'status','Planning') not in('Not Started','Brief Needed','Brief Received','Planning') then raise exception 'project_initial_status_invalid';end if;
 start_day=(p_payload->>'startDate')::date;due_day=(p_payload->>'deadline')::date;
 if start_day is null or due_day is null or not isfinite(start_day) or not isfinite(due_day) or due_day<start_day then raise exception 'project_dates_required';end if;
 select * into c from public.client_accounts where organization_id=p_organization_id and legacy_record_id=p_payload->>'clientId' and deleted_at is null and archived_at is null;
 if c.id is null then raise exception 'project_client_unavailable';end if;
 manager_record_id=p_payload->>'projectManagerId';manager_user=public.task_user_for_employee_v2(manager_record_id);
 if manager_user is null or not exists(select 1 from public.records e join public.organization_members m on m.organization_id=e.organization_id and m.user_id=manager_user and m.status='ACTIVE' join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where e.organization_id=p_organization_id and e.id=manager_record_id and e.coll='employees' and e.deleted_at is null) then raise exception 'project_manager_review_required';end if;
 if nullif(p_payload->>'accountManagerId','') is not null and not exists(select 1 from public.records e join public.organization_members m on m.organization_id=e.organization_id and m.user_id=public.task_user_for_employee_v2(e.id) and m.status='ACTIVE' join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where e.organization_id=p_organization_id and e.id=p_payload->>'accountManagerId' and e.coll='employees' and e.deleted_at is null) then raise exception 'project_account_manager_review_required';end if;
 budget=coalesce(nullif(p_payload->>'projectBudget',''),'0')::numeric;
 if budget<0 or budget>999999999999.99 or budget::text in('NaN','Infinity','-Infinity') or budget<>round(budget,2) then raise exception 'project_budget_invalid';end if;
 if (p_payload->>'createInvoice')::boolean and coalesce(p_payload->>'currency','')!~'^[A-Z]{3}$' then raise exception 'project_invoice_currency_required';end if;
 if (p_payload->>'createInvoice')::boolean and budget<=0 then raise exception 'project_invoice_positive_budget_required';end if;
 if (p_payload->>'createDefaultTasks')::boolean then
  select t.titles into titles from public.project_task_templates_v2 t where t.key=p_payload->>'projectType';
  if titles is null then raise exception 'project_template_unavailable';end if;
  template_owner=p_payload->>'templateAssigneeId';template_user=public.task_user_for_employee_v2(template_owner);
  if template_user is null or not exists(select 1 from public.records e join public.organization_members m on m.organization_id=e.organization_id and m.user_id=template_user and m.status='ACTIVE' join public.profiles p on p.id=m.user_id and p.identity_status='ACTIVE' where e.organization_id=p_organization_id and e.id=template_owner and e.coll='employees' and e.deleted_at is null) then raise exception 'project_template_assignee_required';end if;
 end if;
 project_id='prj-'||gen_random_uuid()::text;project_data='{}'::jsonb;
 foreach field in array array['projectName','projectType','clientId','priority','objective','scope','brief','briefLink','referencesLinks','projectManagerId','accountManagerId','driveFolder','finalDeliveryFolder','notes'] loop
  if p_payload ? field and jsonb_typeof(p_payload->field) not in('string','null') then raise exception 'project_field_type_invalid';end if;
  if p_payload ? field then project_data=project_data||jsonb_build_object(field,p_payload->field);end if;
 end loop;
 project_data=project_data||jsonb_build_object('id',project_id,'projectCode','PRJ-'||upper(replace(substr(project_id,5),'-','')),'name',btrim(p_payload->>'projectName'),'projectName',btrim(p_payload->>'projectName'),'status',coalesce(p_payload->>'status','Planning'),'projectBudget',budget,'currency',coalesce(p_payload->>'currency','EGP'),'startDate',start_day,'deadline',due_day,'createdAt',now(),'updatedAt',now(),'createdBy',auth.uid());
 insert into public.records(id,coll,organization_id,data) values(project_id,'projects',p_organization_id,project_data);
 changes=changes||jsonb_build_array(jsonb_build_object('coll','projects','record',project_data));
 if titles is not null then
  for task_title in select jsonb_array_elements_text(titles) loop
   task_result=public.create_task_v2(p_organization_id,task_title,c.id,project_id,template_owner,'Backlog','Normal',null,start_day,due_day,0,coalesce(p_payload->>'brief',p_payload->>'scope',''),null,null,false);
   if not coalesce((task_result->>'ok')::boolean,false) then raise exception 'project_task_creation_failed';end if;
   select data||jsonb_build_object('id',id) into task_data from public.records where id=task_result->'task'->>'legacyRecordId' and organization_id=p_organization_id and coll='tasks';
   if task_data is null then raise exception 'project_task_projection_missing';end if;
   changes=changes||jsonb_build_array(jsonb_build_object('coll','tasks','record',task_data));
  end loop;
 end if;
 if (p_payload->>'createInvoice')::boolean then
  invoice_id='inv-'||gen_random_uuid()::text;
  invoice_data=jsonb_build_object('id',invoice_id,'invoiceNumber','INV-'||upper(replace(gen_random_uuid()::text,'-','')),'clientId',c.legacy_record_id,'projectId',project_id,'amount',budget,'currency',p_payload->>'currency','tax',0,'discount',0,'status','Draft','issueDate',current_date,'dueDate',greatest(current_date,due_day),'createdAt',now(),'updatedAt',now(),'createdBy',auth.uid());
  insert into public.records(id,coll,organization_id,data) values(invoice_id,'invoices',p_organization_id,invoice_data);
  if not exists(select 1 from public.finance_invoices where organization_id=p_organization_id and legacy_record_id=invoice_id and relationship_state='VALID') then raise exception 'project_invoice_projection_missing';end if;
  project_data=project_data||jsonb_build_object('invoiceId',invoice_id);
  update public.records set data=project_data where id=project_id and organization_id=p_organization_id;
  changes=jsonb_set(changes,'{0,record}',project_data);
  changes=changes||jsonb_build_array(jsonb_build_object('coll','invoices','record',invoice_data));
 end if;
 insert into public.audit_events(organization_id,actor_user_id,action,entity_type,entity_id,safe_context) values(p_organization_id,auth.uid(),'PROJECT_SETUP_CREATED','project',project_id,jsonb_build_object('commandId',p_command_id,'taskCount',coalesce(jsonb_array_length(titles),0),'draftInvoiceId',invoice_id));
 result=jsonb_build_object('ok',true,'project',project_data,'changes',changes);
 insert into public.project_setup_commands_v2 values(p_organization_id,p_command_id,auth.uid(),p_payload,result,now());
 return result;
end;$$;
revoke all on function public.create_project_setup_v2(uuid,jsonb,uuid) from public,anon;
grant execute on function public.create_project_setup_v2(uuid,jsonb,uuid) to authenticated;
commit;
-- Rollback application entry point only; retain committed records/ledger/audit.
