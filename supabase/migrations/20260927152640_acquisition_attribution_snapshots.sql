begin;
-- New downstream records inherit a tenant-checked source snapshot; existing records untouched.
create function public.acquisition_attribution_snapshot_v2() returns trigger language plpgsql security definer set search_path='' as $$
declare source_data jsonb; source_lead text;
begin
 if new.coll not in ('clients','proposals','quotations') then return new; end if;
 source_lead:=nullif(new.data->>'leadId','');
 if source_lead is not null then
  select payload into source_data from public.crm_leads where organization_id=new.organization_id and legacy_record_id=source_lead and deleted_at is null;
 elsif new.coll in ('proposals','quotations') then
  select data->'acquisitionAttribution' into source_data from public.records where organization_id=new.organization_id and coll='clients' and id=new.data->>'clientId' and deleted_at is null;
 end if;
 if source_data is not null then
  new.data:=new.data||jsonb_build_object('acquisitionAttribution',(select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) from jsonb_each(source_data) e(k,v) where k in ('utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid','ttclid','landing_page','referrer','language','form_source','qualification','source')));
 end if;
 return new;
end $$;
revoke all on function public.acquisition_attribution_snapshot_v2() from public,anon,authenticated;
create trigger acquisition_attribution_snapshot_v2 before insert on public.records for each row execute function public.acquisition_attribution_snapshot_v2();
commit;
