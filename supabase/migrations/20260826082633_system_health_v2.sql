-- MAGNET OS V2 / M13: safe, tenant-scoped operational health snapshot.
--
-- This function is intentionally read-only and aggregate-only. It lets an
-- organization owner/admin diagnose the database, identity, storage and
-- delivery queues without exposing credentials, recipients, payloads, file
-- paths or any other business record content.

begin;

create or replace function public.system_health_snapshot_v2(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  organization_row public.organizations%rowtype;
  database_snapshot jsonb;
  auth_snapshot jsonb;
  storage_snapshot jsonb;
  outbox_snapshot jsonb;
  jobs_snapshot jsonb;
begin
  if p_organization_id is null then
    raise exception using errcode = 'P0001', message = 'active_organization_required';
  end if;

  select organization.* into organization_row
  from public.organizations organization
  where organization.id = p_organization_id
    and organization.deleted_at is null;

  if organization_row.id is null or not public.is_active_org_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'active_membership_required';
  end if;

  if not public.has_org_capability(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'organization_manage_capability_required';
  end if;

  select jsonb_build_object(
    'status', 'HEALTHY',
    'version', current_setting('server_version'),
    'publicTables', (select count(*) from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace where namespace.nspname='public' and relation.relkind in ('r','p')),
    'functions', (select count(*) from pg_catalog.pg_proc procedure join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace where namespace.nspname='public'),
    'triggers', (select count(*) from pg_catalog.pg_trigger trigger join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace where namespace.nspname='public' and not trigger.tgisinternal),
    'migrations', (select count(*) from public.migration_audit),
    'latestMigration', (select migration from public.migration_audit order by applied_at desc, migration desc limit 1),
    'businessRecords', (select count(*) from public.records record where record.organization_id=p_organization_id and record.deleted_at is null)
  ) into database_snapshot;

  select jsonb_build_object(
    'activeProfiles', count(*) filter (where profile.identity_status='ACTIVE'),
    'memberships', count(*),
    'membershipStatuses', coalesce((
      select jsonb_object_agg(status_count.status, status_count.total)
      from (
        select membership.status, count(*) as total
        from public.organization_members membership
        where membership.organization_id=p_organization_id
        group by membership.status
      ) status_count
    ), '{}'::jsonb),
    'profileStatuses', coalesce((
      select jsonb_object_agg(status_count.identity_status, status_count.total)
      from (
        select profile_inner.identity_status, count(*) as total
        from public.organization_members membership_inner
        join public.profiles profile_inner on profile_inner.id=membership_inner.user_id
        where membership_inner.organization_id=p_organization_id
        group by profile_inner.identity_status
      ) status_count
    ), '{}'::jsonb)
  ) into auth_snapshot
  from public.organization_members membership
  join public.profiles profile on profile.id=membership.user_id
  where membership.organization_id=p_organization_id;

  select jsonb_build_object(
    'buckets', count(distinct object.bucket_id),
    'objects', count(*),
    'bytes', coalesce(sum((object.metadata->>'size')::bigint) filter (where (object.metadata->>'size') ~ '^[0-9]+$'), 0),
    'documentRows', (select count(*) from public.document_files document where document.organization_id=p_organization_id and document.deleted_at is null),
    'uploadingDocuments', (select count(*) from public.document_files document where document.organization_id=p_organization_id and document.deleted_at is null and document.status='UPLOADING')
  ) into storage_snapshot
  from storage.objects object
  where object.name like p_organization_id::text || '/%';

  select jsonb_build_object(
    'total', count(*),
    'statuses', coalesce((
      select jsonb_object_agg(status_count.status, status_count.total)
      from (
        select message.status, count(*) as total
        from public.outbox_messages message
        where message.organization_id=p_organization_id
        group by message.status
      ) status_count
    ), '{}'::jsonb),
    'failedLast24Hours', count(*) filter (where message.status='FAILED' and message.updated_at >= now()-interval '24 hours'),
    'oldestReadyAgeSeconds', coalesce(extract(epoch from now()-(min(message.created_at) filter (where message.status in ('PENDING','FAILED'))))::bigint, 0),
    'lastDeliveredAt', max(message.delivered_at)
  ) into outbox_snapshot
  from public.outbox_messages message
  where message.organization_id=p_organization_id;

  select jsonb_build_object(
    'total', count(*),
    'statuses', coalesce((
      select jsonb_object_agg(status_count.status, status_count.total)
      from (
        select job.status, count(*) as total
        from public.jobs job
        where job.organization_id=p_organization_id
        group by job.status
      ) status_count
    ), '{}'::jsonb),
    'failedLast24Hours', count(*) filter (where job.status in ('FAILED','DEAD') and job.updated_at >= now()-interval '24 hours'),
    'oldestReadyAgeSeconds', coalesce(extract(epoch from now()-(min(job.created_at) filter (where job.status in ('PENDING','FAILED'))))::bigint, 0)
  ) into jobs_snapshot
  from public.jobs job
  where job.organization_id=p_organization_id;

  return jsonb_build_object(
    'ok', true,
    'checkedAt', now(),
    'organization', jsonb_build_object('status', organization_row.status),
    'database', database_snapshot,
    'auth', auth_snapshot,
    'storage', storage_snapshot,
    'outbox', outbox_snapshot,
    'jobs', jobs_snapshot
  );
end;
$$;

revoke all on function public.system_health_snapshot_v2(uuid) from public, anon;
grant execute on function public.system_health_snapshot_v2(uuid) to authenticated, service_role;

insert into public.migration_audit(migration,note)
select
  '20260826082633_system_health_v2',
  'Added an aggregate-only, owner-authorized operational health snapshot for database, identity, storage, outbox and jobs. No credentials, recipients, payloads or file paths are returned.'
where not exists (
  select 1 from public.migration_audit where migration='20260826082633_system_health_v2'
);

commit;

-- Rollback: revoke execute and replace the function with a reviewed forward
-- migration. The function stores no state and changes no business records.
