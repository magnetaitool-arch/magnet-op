-- MAGNET OS V2 / M7: canonical, tenant-safe finance read model.
--
-- Legacy records remain the compatibility write model while the monolith is
-- reduced incrementally. New invoice/payment inserts are validated before
-- they reach the legacy table, and the Finance V2 UI reads only through the
-- capability-scoped RPC below. Historical anomalies are quarantined in an
-- explicit issue register instead of being silently discarded or invented.

begin;

create or replace function public.finance_number(p_value jsonb)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare raw_value text;
begin
  if p_value is null or p_value = 'null'::jsonb then return 0; end if;
  raw_value := btrim(p_value #>> '{}');
  if raw_value ~ '^-?[0-9]+([.][0-9]+)?$' then return raw_value::numeric; end if;
  return 0;
end;
$$;

create or replace function public.finance_invoice_subtotal(p_data jsonb)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare result numeric;
begin
  if jsonb_typeof(p_data->'items') = 'array' and jsonb_array_length(p_data->'items') > 0 then
    select coalesce(sum(
      greatest(1, public.finance_number(coalesce(item->'quantity', item->'qty', '1'::jsonb)))
      * public.finance_number(item->'unitPrice')
    ), 0) into result
    from jsonb_array_elements(p_data->'items') item;
    if result > 0 then return round(result, 2); end if;
  end if;
  return round(public.finance_number(p_data->'amount'), 2);
end;
$$;

create or replace function public.finance_invoice_total(p_data jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(greatest(0,
    (public.finance_invoice_subtotal(p_data) - public.finance_number(p_data->'discount'))
    * (1 + greatest(0, public.finance_number(p_data->'tax')) / 100)
  ), 2);
$$;

create or replace function public.normalize_finance_invoice_status(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(btrim(coalesce(p_status, '')))
    when 'draft' then 'Draft'
    when 'invoice draft' then 'Draft'
    when 'issued' then 'Issued'
    when 'sent' then 'Issued'
    when 'invoice sent' then 'Issued'
    when 'partially paid' then 'Partially Paid'
    when 'paid' then 'Paid'
    when 'overdue' then 'Overdue'
    when 'cancelled' then 'Cancelled'
    when 'canceled' then 'Cancelled'
    else 'Draft'
  end;
$$;

create table if not exists public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null references public.records(id) on delete restrict,
  client_account_id uuid not null,
  legacy_client_id text not null,
  legacy_project_id text,
  legacy_contract_id text,
  invoice_number text not null,
  issue_date date not null,
  due_date date not null,
  currency text not null default 'EGP' check (char_length(currency) between 3 and 8),
  subtotal numeric(16,2) not null default 0 check (subtotal >= 0),
  tax_percent numeric(7,3) not null default 0 check (tax_percent >= 0),
  discount numeric(16,2) not null default 0 check (discount >= 0),
  total numeric(16,2) not null default 0 check (total >= 0),
  stored_status text not null default 'Draft' check (stored_status in (
    'Draft','Issued','Partially Paid','Paid','Overdue','Cancelled'
  )),
  relationship_state text not null default 'VALID' check (relationship_state in (
    'VALID','MISSING_PROJECT_OR_CONTRACT'
  )),
  payload jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (organization_id, client_account_id)
    references public.client_accounts(organization_id, id) on delete restrict,
  unique (organization_id, legacy_record_id),
  unique (organization_id, id),
  unique (organization_id, invoice_number)
);

create index if not exists finance_invoices_org_dates_idx
  on public.finance_invoices (organization_id, issue_date desc, due_date)
  where deleted_at is null;
create index if not exists finance_invoices_client_idx
  on public.finance_invoices (organization_id, client_account_id, issue_date desc)
  where deleted_at is null;

create table if not exists public.finance_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_record_id text not null references public.records(id) on delete restrict,
  invoice_id uuid not null,
  client_account_id uuid not null,
  payment_number text not null,
  amount numeric(16,2) not null check (amount > 0),
  method text not null default 'Bank',
  paid_on date not null,
  reference text,
  attachment_url text,
  created_by_label text,
  payload jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (organization_id, invoice_id)
    references public.finance_invoices(organization_id, id) on delete restrict,
  foreign key (organization_id, client_account_id)
    references public.client_accounts(organization_id, id) on delete restrict,
  unique (organization_id, legacy_record_id),
  unique (organization_id, payment_number)
);

create index if not exists finance_payments_org_date_idx
  on public.finance_payments (organization_id, paid_on desc)
  where deleted_at is null;
create index if not exists finance_payments_invoice_idx
  on public.finance_payments (organization_id, invoice_id, paid_on desc)
  where deleted_at is null;

create table if not exists public.finance_projection_issues (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  legacy_collection text not null,
  legacy_record_id text not null,
  issue_code text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (organization_id, legacy_collection, legacy_record_id, issue_code)
);

create or replace function public.validate_new_finance_legacy_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare linked_record public.records%rowtype;
begin
  if new.deleted_at is not null or lower(coalesce(new.data->>'_del', 'false')) = 'true' then
    return new;
  end if;
  if new.coll = 'invoices' and tg_op = 'INSERT' then
    if nullif(btrim(new.data->>'clientId'), '') is null then
      raise exception using errcode = '23514', message = 'invoice_client_required';
    end if;
    perform 1 from public.records client
    where client.organization_id = new.organization_id and client.coll = 'clients'
      and client.id = new.data->>'clientId' and client.deleted_at is null
      and lower(coalesce(client.data->>'_del', 'false')) <> 'true';
    if not found then raise exception using errcode = '23503', message = 'invoice_client_not_found'; end if;
    if nullif(btrim(new.data->>'projectId'), '') is null
       and nullif(btrim(new.data->>'contractId'), '') is null
       and nullif(btrim(new.data->>'relatedContractId'), '') is null then
      raise exception using errcode = '23514', message = 'invoice_project_or_contract_required';
    end if;
    if nullif(btrim(new.data->>'projectId'), '') is not null then
      perform 1 from public.records project
      where project.organization_id = new.organization_id and project.coll = 'projects'
        and project.id = new.data->>'projectId' and project.data->>'clientId' = new.data->>'clientId'
        and project.deleted_at is null and lower(coalesce(project.data->>'_del', 'false')) <> 'true';
      if not found then raise exception using errcode = '23503', message = 'invoice_project_client_mismatch'; end if;
    else
      perform 1 from public.records contract
      where contract.organization_id = new.organization_id and contract.coll = 'contracts'
        and contract.id = coalesce(nullif(btrim(new.data->>'contractId'), ''), nullif(btrim(new.data->>'relatedContractId'), ''))
        and contract.data->>'clientId' = new.data->>'clientId'
        and contract.deleted_at is null and lower(coalesce(contract.data->>'_del', 'false')) <> 'true';
      if not found then raise exception using errcode = '23503', message = 'invoice_contract_client_mismatch'; end if;
    end if;
  elsif new.coll = 'payments' and tg_op = 'INSERT' then
    if nullif(btrim(new.data->>'invoiceId'), '') is null then
      raise exception using errcode = '23514', message = 'payment_invoice_required';
    end if;
    select * into linked_record from public.records invoice
    where invoice.organization_id = new.organization_id and invoice.coll = 'invoices'
      and invoice.id = new.data->>'invoiceId' and invoice.deleted_at is null
      and lower(coalesce(invoice.data->>'_del', 'false')) <> 'true';
    if linked_record.id is null then raise exception using errcode = '23503', message = 'payment_invoice_not_found'; end if;
    if public.finance_number(new.data->'amount') <= 0 then
      raise exception using errcode = '23514', message = 'payment_amount_must_be_positive';
    end if;
    new.data := new.data || jsonb_build_object('clientId', linked_record.data->>'clientId');
  end if;
  return new;
end;
$$;

drop trigger if exists records_validate_new_finance_v2 on public.records;
create trigger records_validate_new_finance_v2
  before insert on public.records
  for each row when (new.coll in ('invoices','payments'))
  execute function public.validate_new_finance_legacy_record();

create or replace function public.sync_finance_v2_from_legacy_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare d jsonb := coalesce(new.data, '{}'::jsonb);
declare canonical_client public.client_accounts%rowtype;
declare canonical_invoice public.finance_invoices%rowtype;
declare invoice_subtotal numeric;
declare invoice_discount numeric;
declare invoice_tax numeric;
declare invoice_total numeric;
declare legacy_invoice_id text;
begin
  if new.coll not in ('invoices','payments') then return new; end if;

  if new.coll = 'invoices' then
    if new.deleted_at is not null or lower(coalesce(d->>'_del', 'false')) = 'true' then
      update public.finance_invoices set deleted_at = coalesce(new.deleted_at, now()),
        updated_at = now(), version = version + 1
      where organization_id = new.organization_id and legacy_record_id = new.id and deleted_at is null;
      return new;
    end if;
    select * into canonical_client from public.client_accounts
    where organization_id = new.organization_id and legacy_record_id = d->>'clientId'
      and deleted_at is null;
    if canonical_client.id is null then
      insert into public.finance_projection_issues (
        organization_id, legacy_collection, legacy_record_id, issue_code
      ) values (new.organization_id, new.coll, new.id, 'MISSING_CLIENT')
      on conflict (organization_id, legacy_collection, legacy_record_id, issue_code)
      do update set last_seen_at = now(), resolved_at = null;
      return new;
    end if;
    invoice_subtotal := public.finance_invoice_subtotal(d);
    invoice_discount := greatest(0, public.finance_number(d->'discount'));
    invoice_tax := greatest(0, public.finance_number(d->'tax'));
    invoice_total := public.finance_invoice_total(d);
    insert into public.finance_invoices (
      organization_id, legacy_record_id, client_account_id, legacy_client_id,
      legacy_project_id, legacy_contract_id, invoice_number, issue_date,
      due_date, currency, subtotal, tax_percent, discount, total,
      stored_status, relationship_state, payload, created_at
    ) values (
      new.organization_id, new.id, canonical_client.id, canonical_client.legacy_record_id,
      nullif(btrim(d->>'projectId'), ''),
      coalesce(nullif(btrim(d->>'contractId'), ''), nullif(btrim(d->>'relatedContractId'), '')),
      coalesce(nullif(btrim(d->>'invoiceNumber'), ''), 'INV-' || upper(left(replace(new.id, '-', ''), 12))),
      coalesce(nullif(d->>'issueDate', '')::date, coalesce(new.created_at, now())::date),
      coalesce(nullif(d->>'dueDate', '')::date, coalesce(new.created_at, now())::date),
      coalesce(nullif(upper(btrim(d->>'currency')), ''), 'EGP'),
      invoice_subtotal, invoice_tax, invoice_discount, invoice_total,
      public.normalize_finance_invoice_status(d->>'status'),
      case when nullif(btrim(d->>'projectId'), '') is null
             and nullif(btrim(d->>'contractId'), '') is null
             and nullif(btrim(d->>'relatedContractId'), '') is null
        then 'MISSING_PROJECT_OR_CONTRACT' else 'VALID' end,
      d, coalesce(new.created_at, now())
    )
    on conflict (organization_id, legacy_record_id) do update set
      client_account_id = excluded.client_account_id,
      legacy_client_id = excluded.legacy_client_id,
      legacy_project_id = excluded.legacy_project_id,
      legacy_contract_id = excluded.legacy_contract_id,
      invoice_number = excluded.invoice_number,
      issue_date = excluded.issue_date,
      due_date = excluded.due_date,
      currency = excluded.currency,
      subtotal = excluded.subtotal,
      tax_percent = excluded.tax_percent,
      discount = excluded.discount,
      total = excluded.total,
      stored_status = excluded.stored_status,
      relationship_state = excluded.relationship_state,
      payload = excluded.payload,
      updated_at = now(), deleted_at = null,
      version = public.finance_invoices.version + 1;
    update public.finance_projection_issues set resolved_at = now(), last_seen_at = now()
    where organization_id = new.organization_id and legacy_collection = 'invoices'
      and legacy_record_id = new.id and issue_code = 'MISSING_CLIENT' and resolved_at is null;
    return new;
  end if;

  if new.deleted_at is not null or lower(coalesce(d->>'_del', 'false')) = 'true' then
    update public.finance_payments set deleted_at = coalesce(new.deleted_at, now()),
      updated_at = now(), version = version + 1
    where organization_id = new.organization_id and legacy_record_id = new.id and deleted_at is null;
    return new;
  end if;
  legacy_invoice_id := nullif(btrim(d->>'invoiceId'), '');
  select * into canonical_invoice from public.finance_invoices
  where organization_id = new.organization_id and legacy_record_id = legacy_invoice_id
    and deleted_at is null;
  if canonical_invoice.id is null then
    insert into public.finance_projection_issues (
      organization_id, legacy_collection, legacy_record_id, issue_code
    ) values (new.organization_id, new.coll, new.id, 'MISSING_OR_INVALID_INVOICE')
    on conflict (organization_id, legacy_collection, legacy_record_id, issue_code)
    do update set last_seen_at = now(), resolved_at = null;
    delete from public.finance_payments
    where organization_id = new.organization_id and legacy_record_id = new.id;
    return new;
  end if;
  if public.finance_number(d->'amount') <= 0 then
    insert into public.finance_projection_issues (
      organization_id, legacy_collection, legacy_record_id, issue_code
    ) values (new.organization_id, new.coll, new.id, 'INVALID_PAYMENT_AMOUNT')
    on conflict (organization_id, legacy_collection, legacy_record_id, issue_code)
    do update set last_seen_at = now(), resolved_at = null;
    delete from public.finance_payments
    where organization_id = new.organization_id and legacy_record_id = new.id;
    return new;
  end if;
  insert into public.finance_payments (
    organization_id, legacy_record_id, invoice_id, client_account_id,
    payment_number, amount, method, paid_on, reference, attachment_url,
    created_by_label, payload, created_at
  ) values (
    new.organization_id, new.id, canonical_invoice.id, canonical_invoice.client_account_id,
    coalesce(nullif(btrim(d->>'paymentNumber'), ''), 'PAY-' || upper(left(replace(new.id, '-', ''), 12))),
    round(public.finance_number(d->'amount'), 2),
    coalesce(nullif(btrim(d->>'method'), ''), 'Bank'),
    coalesce(nullif(d->>'date', '')::date, coalesce(new.created_at, now())::date),
    nullif(btrim(d->>'reference'), ''), nullif(btrim(d->>'attachment'), ''),
    nullif(btrim(d->>'createdBy'), ''), d, coalesce(new.created_at, now())
  )
  on conflict (organization_id, legacy_record_id) do update set
    invoice_id = excluded.invoice_id,
    client_account_id = excluded.client_account_id,
    payment_number = excluded.payment_number,
    amount = excluded.amount,
    method = excluded.method,
    paid_on = excluded.paid_on,
    reference = excluded.reference,
    attachment_url = excluded.attachment_url,
    created_by_label = excluded.created_by_label,
    payload = excluded.payload,
    updated_at = now(), deleted_at = null,
    version = public.finance_payments.version + 1;
  update public.finance_projection_issues set resolved_at = now(), last_seen_at = now()
  where organization_id = new.organization_id and legacy_collection = 'payments'
    and legacy_record_id = new.id and resolved_at is null;
  return new;
end;
$$;

drop trigger if exists records_sync_finance_v2 on public.records;
create trigger records_sync_finance_v2
  after insert or update on public.records
  for each row execute function public.sync_finance_v2_from_legacy_record();

drop trigger if exists finance_invoices_set_updated_at on public.finance_invoices;
create trigger finance_invoices_set_updated_at before update on public.finance_invoices
  for each row execute function public.set_saas_updated_at();
drop trigger if exists finance_payments_set_updated_at on public.finance_payments;
create trigger finance_payments_set_updated_at before update on public.finance_payments
  for each row execute function public.set_saas_updated_at();

update public.records set data = data
where coll in ('invoices','payments') and deleted_at is null
  and lower(coalesce(data->>'_del', 'false')) <> 'true';

do $$
declare legacy_invoices integer;
declare canonical_invoices integer;
declare valid_payments integer;
declare canonical_payments integer;
begin
  select count(*) into legacy_invoices from public.records
  where coll = 'invoices' and deleted_at is null and lower(coalesce(data->>'_del', 'false')) <> 'true'
    and exists (select 1 from public.client_accounts c
      where c.organization_id = records.organization_id and c.legacy_record_id = records.data->>'clientId'
        and c.deleted_at is null);
  select count(*) into canonical_invoices from public.finance_invoices where deleted_at is null;
  select count(*) into valid_payments from public.records payment
  where payment.coll = 'payments' and payment.deleted_at is null
    and lower(coalesce(payment.data->>'_del', 'false')) <> 'true'
    and public.finance_number(payment.data->'amount') > 0
    and exists (select 1 from public.finance_invoices invoice
      where invoice.organization_id = payment.organization_id
        and invoice.legacy_record_id = payment.data->>'invoiceId' and invoice.deleted_at is null);
  select count(*) into canonical_payments from public.finance_payments where deleted_at is null;
  if legacy_invoices <> canonical_invoices or valid_payments <> canonical_payments then
    raise exception 'M7 projection mismatch: invoices %/%, payments %/%',
      legacy_invoices, canonical_invoices, valid_payments, canonical_payments;
  end if;
end $$;

alter table public.finance_invoices enable row level security;
alter table public.finance_payments enable row level security;
alter table public.finance_projection_issues enable row level security;

revoke all privileges on public.finance_invoices, public.finance_payments,
  public.finance_projection_issues from public, anon, authenticated;
grant select, insert, update, delete on public.finance_invoices, public.finance_payments,
  public.finance_projection_issues to service_role;
grant usage, select on sequence public.finance_projection_issues_id_seq to service_role;

create policy finance_invoices_member_read on public.finance_invoices
  for select to authenticated
  using (deleted_at is null and public.has_org_capability(organization_id, 'finance.read'));
create policy finance_payments_member_read on public.finance_payments
  for select to authenticated
  using (deleted_at is null and public.has_org_capability(organization_id, 'finance.read'));
create policy finance_projection_issues_manager_read on public.finance_projection_issues
  for select to authenticated
  using (public.has_org_capability(organization_id, 'finance.manage'));
grant select on public.finance_invoices, public.finance_payments,
  public.finance_projection_issues to authenticated;

create or replace function public.finance_invoice_effective_status(
  p_stored_status text, p_due_date date, p_total numeric, p_paid numeric
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_stored_status = 'Cancelled' then 'Cancelled'
    when coalesce(p_paid, 0) >= greatest(0, coalesce(p_total, 0)) - 0.01
      and coalesce(p_total, 0) > 0 then 'Paid'
    when coalesce(p_paid, 0) > 0 then 'Partially Paid'
    when p_stored_status <> 'Draft' and p_due_date < current_date then 'Overdue'
    else p_stored_status
  end;
$$;

create or replace function public.get_finance_workspace(
  p_organization_id uuid,
  p_tab text default 'Invoices',
  p_search text default null,
  p_status text default null,
  p_legacy_client_id text default null,
  p_from_date date default null,
  p_to_date date default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare tab_name text := initcap(lower(btrim(coalesce(p_tab, 'Invoices'))));
declare normalized_search text := left(btrim(coalesce(p_search, '')), 120);
declare normalized_status text := left(btrim(coalesce(p_status, '')), 80);
declare page_number integer := greatest(1, coalesce(p_page, 1));
declare page_size integer := greatest(1, least(coalesce(p_page_size, 25), 100));
declare summary jsonb;
declare items jsonb := '[]'::jsonb;
declare total_rows integer := 0;
declare issue_count integer := 0;
begin
  if not public.has_org_capability(p_organization_id, 'finance.read') then
    raise exception using errcode = '42501', message = 'finance_read_required';
  end if;
  if tab_name not in ('Invoices','Payments','Expenses','Payroll','Contracts') then tab_name := 'Invoices'; end if;

  with invoice_paid as (
    select invoice.id, invoice.total,
      coalesce(sum(payment.amount) filter (where payment.deleted_at is null), 0) paid,
      invoice.stored_status, invoice.due_date
    from public.finance_invoices invoice
    left join public.finance_payments payment on payment.organization_id = invoice.organization_id
      and payment.invoice_id = invoice.id
    where invoice.organization_id = p_organization_id and invoice.deleted_at is null
    group by invoice.id
  ), expense_totals as (
    select coalesce(sum(public.finance_number(record.data->'amount')), 0) amount
    from public.records record where record.organization_id = p_organization_id
      and record.coll = 'expenses' and record.deleted_at is null
      and lower(coalesce(record.data->>'_del', 'false')) <> 'true'
      and lower(coalesce(record.data->>'status', 'approved')) not in ('rejected','cancelled')
  ), payroll_totals as (
    select coalesce(sum(greatest(0,
      public.finance_number(record.data->'baseSalary')
      + public.finance_number(record.data->'bonus')
      - public.finance_number(record.data->'penalties')
    )), 0) amount
    from public.records record where record.organization_id = p_organization_id
      and record.coll = 'employeePayments' and record.deleted_at is null
      and lower(coalesce(record.data->>'_del', 'false')) <> 'true'
  )
  select jsonb_build_object(
    'revenue', coalesce(sum(ip.total) filter (where ip.stored_status not in ('Draft','Cancelled')), 0),
    'collected', coalesce(sum(ip.paid), 0),
    'outstanding', coalesce(sum(greatest(0, ip.total - ip.paid))
      filter (where ip.stored_status not in ('Draft','Cancelled')), 0),
    'overdue', coalesce(sum(greatest(0, ip.total - ip.paid))
      filter (where public.finance_invoice_effective_status(ip.stored_status, ip.due_date, ip.total, ip.paid) = 'Overdue'), 0),
    'expenses', (select amount from expense_totals),
    'payroll', (select amount from payroll_totals),
    'net', coalesce(sum(ip.paid), 0) - (select amount from expense_totals) - (select amount from payroll_totals)
  ) into summary from invoice_paid ip;

  select count(*)::integer into issue_count from public.finance_projection_issues issue
  where issue.organization_id = p_organization_id and issue.resolved_at is null;

  if tab_name = 'Invoices' then
    with rows as (
      select invoice.*, client.display_name client_name,
        coalesce(sum(payment.amount) filter (where payment.deleted_at is null), 0) paid_amount
      from public.finance_invoices invoice
      join public.client_accounts client on client.organization_id = invoice.organization_id
        and client.id = invoice.client_account_id
      left join public.finance_payments payment on payment.organization_id = invoice.organization_id
        and payment.invoice_id = invoice.id
      where invoice.organization_id = p_organization_id and invoice.deleted_at is null
        and (p_legacy_client_id is null or invoice.legacy_client_id = p_legacy_client_id)
        and (p_from_date is null or invoice.issue_date >= p_from_date)
        and (p_to_date is null or invoice.issue_date <= p_to_date)
        and (normalized_search = '' or concat_ws(' ', invoice.invoice_number, client.display_name,
          invoice.currency) ilike '%' || normalized_search || '%')
      group by invoice.id, client.display_name
    ), filtered as (
      select *, public.finance_invoice_effective_status(stored_status, due_date, total, paid_amount) effective_status
      from rows
    )
    select count(*)::integer into total_rows from filtered
    where normalized_status = '' or effective_status = normalized_status;

    with rows as (
      select invoice.*, client.display_name client_name,
        coalesce(sum(payment.amount) filter (where payment.deleted_at is null), 0) paid_amount
      from public.finance_invoices invoice
      join public.client_accounts client on client.organization_id = invoice.organization_id
        and client.id = invoice.client_account_id
      left join public.finance_payments payment on payment.organization_id = invoice.organization_id
        and payment.invoice_id = invoice.id
      where invoice.organization_id = p_organization_id and invoice.deleted_at is null
        and (p_legacy_client_id is null or invoice.legacy_client_id = p_legacy_client_id)
        and (p_from_date is null or invoice.issue_date >= p_from_date)
        and (p_to_date is null or invoice.issue_date <= p_to_date)
        and (normalized_search = '' or concat_ws(' ', invoice.invoice_number, client.display_name,
          invoice.currency) ilike '%' || normalized_search || '%')
      group by invoice.id, client.display_name
    ), filtered as (
      select *, public.finance_invoice_effective_status(stored_status, due_date, total, paid_amount) effective_status
      from rows
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'legacyRecordId', legacy_record_id, 'invoiceNumber', invoice_number,
      'clientId', legacy_client_id, 'clientName', client_name,
      'projectId', legacy_project_id, 'contractId', legacy_contract_id,
      'issueDate', issue_date, 'dueDate', due_date, 'currency', currency,
      'subtotal', subtotal, 'tax', tax_percent, 'discount', discount,
      'total', total, 'paid', paid_amount, 'remaining', greatest(0, total-paid_amount),
      'status', effective_status, 'relationshipState', relationship_state,
      'version', version
    ) order by issue_date desc, invoice_number desc), '[]'::jsonb) into items
    from (select * from filtered
      where normalized_status = '' or effective_status = normalized_status
      order by issue_date desc, invoice_number desc
      offset ((page_number-1)*page_size) limit page_size) page_rows;
  elsif tab_name = 'Payments' then
    select count(*)::integer into total_rows
    from public.finance_payments payment
    join public.finance_invoices invoice on invoice.organization_id = payment.organization_id
      and invoice.id = payment.invoice_id
    join public.client_accounts client on client.organization_id = payment.organization_id
      and client.id = payment.client_account_id
    where payment.organization_id = p_organization_id and payment.deleted_at is null
      and (p_legacy_client_id is null or client.legacy_record_id = p_legacy_client_id)
      and (p_from_date is null or payment.paid_on >= p_from_date)
      and (p_to_date is null or payment.paid_on <= p_to_date)
      and (normalized_search = '' or concat_ws(' ', payment.payment_number,
        invoice.invoice_number, client.display_name, payment.reference, payment.method)
        ilike '%' || normalized_search || '%');
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', payment.id, 'legacyRecordId', payment.legacy_record_id,
      'paymentNumber', payment.payment_number, 'clientId', client.legacy_record_id,
      'clientName', client.display_name, 'invoiceId', invoice.legacy_record_id,
      'invoiceNumber', invoice.invoice_number, 'amount', payment.amount,
      'method', payment.method, 'date', payment.paid_on, 'reference', payment.reference,
      'attachment', payment.attachment_url, 'createdBy', payment.created_by_label
    ) order by payment.paid_on desc, payment.payment_number desc), '[]'::jsonb) into items
    from (select payment.* from public.finance_payments payment
      join public.finance_invoices invoice_filter on invoice_filter.organization_id = payment.organization_id
        and invoice_filter.id = payment.invoice_id
      join public.client_accounts client_filter on client_filter.organization_id = payment.organization_id
        and client_filter.id = payment.client_account_id
      where payment.organization_id = p_organization_id and payment.deleted_at is null
        and (p_legacy_client_id is null or client_filter.legacy_record_id = p_legacy_client_id)
        and (p_from_date is null or payment.paid_on >= p_from_date)
        and (p_to_date is null or payment.paid_on <= p_to_date)
        and (normalized_search = '' or concat_ws(' ', payment.payment_number,
          invoice_filter.invoice_number, client_filter.display_name, payment.reference, payment.method)
          ilike '%' || normalized_search || '%')
      order by payment.paid_on desc offset ((page_number-1)*page_size) limit page_size) payment
    join public.finance_invoices invoice on invoice.organization_id = payment.organization_id and invoice.id = payment.invoice_id
    join public.client_accounts client on client.organization_id = payment.organization_id and client.id = payment.client_account_id;
  else
    select count(*)::integer into total_rows from public.records record
    where record.organization_id = p_organization_id and record.deleted_at is null
      and lower(coalesce(record.data->>'_del', 'false')) <> 'true'
      and record.coll = case tab_name when 'Expenses' then 'expenses'
        when 'Payroll' then 'employeePayments' else 'contracts' end
      and (normalized_search = '' or record.data::text ilike '%' || normalized_search || '%')
      and (normalized_status = '' or coalesce(record.data->>'status', record.data->>'paymentStatus', '') = normalized_status)
      and (p_legacy_client_id is null or record.data->>'clientId' = p_legacy_client_id)
      and (p_from_date is null or coalesce(nullif(record.data->>'date',''), nullif(record.data->>'startDate',''), nullif(record.data->>'periodFrom',''))::date >= p_from_date)
      and (p_to_date is null or coalesce(nullif(record.data->>'date',''), nullif(record.data->>'startDate',''), nullif(record.data->>'periodFrom',''))::date <= p_to_date);
    select coalesce(jsonb_agg(record.data || jsonb_build_object('legacyRecordId', record.id)
      order by record.updated_at desc), '[]'::jsonb) into items
    from (select * from public.records record
      where record.organization_id = p_organization_id and record.deleted_at is null
        and lower(coalesce(record.data->>'_del', 'false')) <> 'true'
        and record.coll = case tab_name when 'Expenses' then 'expenses'
          when 'Payroll' then 'employeePayments' else 'contracts' end
        and (normalized_search = '' or record.data::text ilike '%' || normalized_search || '%')
        and (normalized_status = '' or coalesce(record.data->>'status', record.data->>'paymentStatus', '') = normalized_status)
        and (p_legacy_client_id is null or record.data->>'clientId' = p_legacy_client_id)
      order by record.updated_at desc offset ((page_number-1)*page_size) limit page_size) record;
  end if;

  return jsonb_build_object(
    'summary', coalesce(summary, '{}'::jsonb), 'tab', tab_name,
    'items', coalesce(items, '[]'::jsonb), 'total', total_rows,
    'page', page_number, 'pages', greatest(1, ceil(total_rows::numeric/page_size)::integer),
    'dataIssues', case when public.has_org_capability(p_organization_id, 'finance.manage') then issue_count else 0 end
  );
end;
$$;

revoke all on function public.get_finance_workspace(uuid,text,text,text,text,date,date,integer,integer)
  from public, anon;
grant execute on function public.get_finance_workspace(uuid,text,text,text,text,date,date,integer,integer)
  to authenticated, service_role;

comment on table public.finance_invoices is
  'Canonical M7 invoice read model. Legacy records remain compatibility writes during staged migration.';
comment on table public.finance_payments is
  'Canonical M7 payments; every projected row is linked to one canonical invoice and client.';
comment on table public.finance_projection_issues is
  'Non-sensitive inventory of legacy finance relationships that require administrator repair.';

commit;
