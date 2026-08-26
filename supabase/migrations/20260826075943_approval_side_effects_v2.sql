-- MAGNET OS V2 / M11.1: deterministic approval side effects.
--
-- Approval decisions are persisted by transition_approval_v2. This trigger
-- keeps the legacy revision and attendance projections in the same database
-- transaction, so the browser never has to fake a second successful write.

begin;

create or replace function public.apply_approval_side_effects_v2()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  old_status text := coalesce(old.data->>'status','');
  new_status text := coalesce(new.data->>'status','');
  request_type text := coalesce(new.data->>'requestType','');
  employee_id text := coalesce(nullif(new.data->>'employeeId',''),new.data->>'requestedBy');
  request_date text := coalesce(nullif(new.data->>'date',''),new.data->>'startDate');
  attendance_row public.records%rowtype;
  side_effect_data jsonb;
  note_value text;
  side_effect_id text;
  timestamp_value timestamptz := now();
begin
  if new.coll='deliverables'
     and old_status in ('Client Review','Internal Review')
     and new_status='Revision Requested' then
    side_effect_id:='approval-revision-'||md5(new.id||':'||coalesce(new.data->>'revisionCount','1'));
    side_effect_data:=jsonb_build_object(
      'id',side_effect_id,
      'deliverableId',new.id,
      'clientId',coalesce(new.data->>'clientId',''),
      'projectId',coalesce(new.data->>'projectId',''),
      'requestedBy',coalesce(new.data->>'updatedBy',auth.uid()::text),
      'assignedTo',coalesce(new.data->>'assignedTo',''),
      'note',coalesce(new.data->>'clientFeedback','Please revise'),
      'status','Requested',
      'priority','Med',
      'versionFrom',coalesce((new.data->>'version')::integer,1),
      'versionTo',coalesce((new.data->>'version')::integer,1)+1,
      'createdAt',timestamp_value,
      'updatedAt',timestamp_value,
      'createdBy',coalesce(new.data->>'updatedBy',auth.uid()::text),
      'updatedBy',coalesce(new.data->>'updatedBy',auth.uid()::text)
    );
    insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by)
    values(side_effect_id,'revisions',side_effect_data,new.organization_id,timestamp_value,timestamp_value,
      coalesce(new.data->>'updatedBy',auth.uid()::text),coalesce(new.data->>'updatedBy',auth.uid()::text))
    on conflict(id) do nothing;
  elsif new.coll='approvalRequests'
     and old_status='Pending Approval'
     and new_status='Approved'
     and request_type in ('Lateness Report','Permission Request','Early Leave')
     and nullif(employee_id,'') is not null
     and nullif(request_date,'') is not null then
    select * into attendance_row
    from public.records record
    where record.organization_id=new.organization_id
      and record.coll='attendance'
      and record.deleted_at is null
      and record.data->>'employeeId'=employee_id
      and record.data->>'date'=request_date
    order by record.created_at
    limit 1
    for update;

    note_value:=case request_type
      when 'Lateness Report' then 'Lateness approved'||case when nullif(new.data->>'reason','') is null then '' else ': '||(new.data->>'reason') end
      when 'Early Leave' then 'Early leave approved'
      else 'Permission approved'
    end;
    if request_type in ('Permission Request','Early Leave')
       and (nullif(new.data->>'fromTime','') is not null or nullif(new.data->>'toTime','') is not null) then
      note_value:=note_value||' ('||coalesce(new.data->>'fromTime','')||
        case when nullif(new.data->>'toTime','') is null then '' else '-'||(new.data->>'toTime') end||')';
    end if;

    if attendance_row.id is not null then
      side_effect_data:=attendance_row.data||jsonb_build_object(
        'notes',concat_ws(' · ',nullif(attendance_row.data->>'notes',''),note_value),
        'updatedAt',timestamp_value,
        'updatedBy',coalesce(new.data->>'updatedBy',auth.uid()::text)
      );
      if request_type='Lateness Report' then side_effect_data:=side_effect_data||jsonb_build_object('status','Late'); end if;
      update public.records set data=side_effect_data,updated_at=timestamp_value,
        updated_by=coalesce(new.data->>'updatedBy',auth.uid()::text)
      where id=attendance_row.id;
    elsif request_type='Lateness Report' then
      side_effect_id:='approval-attendance-'||md5(new.id);
      side_effect_data:=jsonb_build_object(
        'id',side_effect_id,'employeeId',employee_id,
        'employeeName',coalesce(new.data->>'requestedByName',''),
        'date',request_date,'checkIn',coalesce(new.data->>'fromTime',''),
        'checkOut','','workMode','Office','status','Late','notes',note_value,
        'source','request','requestId',new.id,
        'createdAt',timestamp_value,'updatedAt',timestamp_value,
        'createdBy',coalesce(new.data->>'updatedBy',auth.uid()::text),
        'updatedBy',coalesce(new.data->>'updatedBy',auth.uid()::text)
      );
      insert into public.records(id,coll,data,organization_id,created_at,updated_at,created_by,updated_by)
      values(side_effect_id,'attendance',side_effect_data,new.organization_id,timestamp_value,timestamp_value,
        coalesce(new.data->>'updatedBy',auth.uid()::text),coalesce(new.data->>'updatedBy',auth.uid()::text))
      on conflict(id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists records_approval_side_effects_v2 on public.records;
create trigger records_approval_side_effects_v2
  after update of data on public.records
  for each row execute function public.apply_approval_side_effects_v2();

revoke all on function public.apply_approval_side_effects_v2() from public,anon,authenticated;
grant execute on function public.apply_approval_side_effects_v2() to service_role;

insert into public.migration_audit(migration,note) values(
  '20260826075943_approval_side_effects_v2',
  'Moved deliverable revision and HR attendance approval projections into the same server transaction; no Production application changes.'
);

commit;

-- Forward-only rollback: disable records_approval_side_effects_v2. Preserve all
-- accepted decisions, revision records, attendance rows and audit history.
