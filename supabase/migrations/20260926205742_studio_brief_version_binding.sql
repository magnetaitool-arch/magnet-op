-- Pin the exact brief version used by a creative asset. No legacy data touched.
-- Rollback is application withdrawal while retaining all Studio records/history.
begin;
alter table public.studio_documents_v2 add column brief_revision integer;
-- Only unambiguous existing references can be populated; never guess a missing brief.
update public.studio_documents_v2 d set brief_revision=b.revision from public.studio_documents_v2 b where d.brief_document_id=b.id and d.organization_id=b.organization_id and b.kind='brief' and b.revision>0;
alter table public.studio_documents_v2 add constraint studio_brief_version_fk foreign key(brief_document_id,brief_revision) references public.studio_versions_v2(document_id,revision) on delete restrict;
alter table public.studio_documents_v2 add constraint studio_brief_version_required check((brief_document_id is null)=(brief_revision is null));
create function public.pin_studio_brief_version_v2() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' and new.brief_document_id is not null then
  select d.revision into new.brief_revision from public.studio_documents_v2 d where d.id=new.brief_document_id and d.organization_id=new.organization_id and d.kind='brief' and d.revision>0;
  if new.brief_revision is null then raise exception 'studio_brief_required';end if;
 elsif tg_op='UPDATE' and (new.brief_document_id,new.brief_revision) is distinct from (old.brief_document_id,old.brief_revision) then raise exception 'studio_brief_version_locked';
 end if;return new;
end;$$;
create trigger studio_brief_version_pin before insert or update on public.studio_documents_v2 for each row execute function public.pin_studio_brief_version_v2();
revoke all on function public.pin_studio_brief_version_v2() from public,anon,authenticated;
commit;
