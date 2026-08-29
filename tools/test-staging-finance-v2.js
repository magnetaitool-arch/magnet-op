#!/usr/bin/env node
'use strict';

// Live M7 canary. It refuses Production and rolls back every synthetic
// client, project, invoice, payment, projection, audit row, and issue row.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { PROTECTED_PROJECT_REFS } = require('./project-safety');
const EXPECTED_STAGING_NAME = 'MAGNET OS STAGING';

function argsOf(argv) {
  const out = {};
  for (const item of argv.slice(2)) {
    if (!item.startsWith('--')) continue;
    const at = item.indexOf('=');
    out[item.slice(2, at < 0 ? undefined : at)] = at < 0 ? true : item.slice(at + 1);
  }
  return out;
}

function safe(value) {
  return String(value || '')
    .replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED_JWT]')
    .slice(-4000);
}

function cli(args) {
  const result = spawnSync('pnpm', ['dlx', 'supabase@latest', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' }
  });
  if (result.status !== 0) throw new Error(safe(result.stderr || result.stdout));
  return result.stdout;
}

function jsonCli(args) {
  const output = cli(args);
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const start = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt) ? arrayAt : objectAt;
  if (start < 0) throw new Error('No JSON payload.');
  return JSON.parse(output.slice(start));
}

const projectRef = String(argsOf(process.argv)['project-ref'] || '').trim();
if (!/^[a-z]{20}$/.test(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
  console.error('Refused: explicit non-Production project ref required.');
  process.exit(2);
}

const project = jsonCli(['projects', 'list', '--output', 'json']).find(item => item.ref === projectRef);
if (!project || project.name !== EXPECTED_STAGING_NAME || project.status !== 'ACTIVE_HEALTHY') {
  console.error('Refused: target is not healthy MAGNET OS STAGING.');
  process.exit(2);
}

const suffix = crypto.randomBytes(12).toString('hex');
const clientId = `cli-m7-${suffix}`;
const projectId = `prj-m7-${suffix}`;
const invoiceId = `inv-m7-${suffix}`;
const paymentId = `pay-m7-${suffix}`;
const invoiceNumber = `SYN-M7-${suffix.slice(0, 12).toUpperCase()}`;
const paymentNumber = `SYN-PAY-${suffix.slice(0, 12).toUpperCase()}`;

const sql = `
begin;
do $test$
declare
  target_organization_id uuid;
  owner_user_id uuid;
  limited_user_id uuid;
  canonical_client_id uuid;
  canonical_invoice_id uuid;
  invoice_result jsonb;
  payment_result jsonb;
  invoice_item jsonb;
  payment_item jsonb;
  rejected_missing_relation boolean := false;
  rejected_missing_invoice boolean := false;
  rejected_limited_role boolean := false;
begin
  select id into target_organization_id
  from public.organizations
  where slug = 'magnet' and status = 'ACTIVE' and deleted_at is null;
  if target_organization_id is null then raise exception 'missing Staging organization'; end if;

  select membership.user_id into owner_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id = membership.role_id
  join public.profiles profile on profile.id = membership.user_id
  where membership.organization_id = target_organization_id
    and membership.status = 'ACTIVE'
    and profile.identity_status = 'ACTIVE'
    and role.key in ('owner', 'admin')
  limit 1;
  if owner_user_id is null then raise exception 'missing active Staging owner'; end if;

  perform set_config('request.jwt.claim.sub', owner_user_id::text, true);

  insert into public.records(id, coll, data, organization_id)
  values ('${clientId}', 'clients', jsonb_build_object(
    'id', '${clientId}', 'brandName', 'Synthetic Finance Client',
    'status', 'Active', 'industry', 'Testing', 'createdAt', now()
  ), target_organization_id);

  select id into canonical_client_id
  from public.client_accounts
  where organization_id = target_organization_id and legacy_record_id = '${clientId}'
    and deleted_at is null;
  if canonical_client_id is null then raise exception 'canonical client projection failed'; end if;

  insert into public.records(id, coll, data, organization_id)
  values ('${projectId}', 'projects', jsonb_build_object(
    'id', '${projectId}', 'clientId', '${clientId}',
    'projectName', 'Synthetic Finance Project', 'status', 'In Progress',
    'createdAt', now()
  ), target_organization_id);

  begin
    insert into public.records(id, coll, data, organization_id)
    values ('bad-inv-m7-${suffix}', 'invoices', jsonb_build_object(
      'id', 'bad-inv-m7-${suffix}', 'clientId', '${clientId}',
      'invoiceNumber', 'BAD-${suffix.slice(0, 8)}', 'amount', 100,
      'status', 'Issued', 'issueDate', current_date, 'dueDate', current_date + 7
    ), target_organization_id);
  exception when check_violation then
    if sqlerrm = 'invoice_project_or_contract_required' then
      rejected_missing_relation := true;
    else
      raise;
    end if;
  end;
  if not rejected_missing_relation then raise exception 'invoice without project/contract was accepted'; end if;

  begin
    insert into public.records(id, coll, data, organization_id)
    values ('bad-pay-m7-${suffix}', 'payments', jsonb_build_object(
      'id', 'bad-pay-m7-${suffix}', 'paymentNumber', 'BAD-PAY-${suffix.slice(0, 8)}',
      'amount', 100, 'date', current_date
    ), target_organization_id);
  exception when check_violation then
    if sqlerrm = 'payment_invoice_required' then
      rejected_missing_invoice := true;
    else
      raise;
    end if;
  end;
  if not rejected_missing_invoice then raise exception 'payment without invoice was accepted'; end if;

  insert into public.records(id, coll, data, organization_id)
  values ('${invoiceId}', 'invoices', jsonb_build_object(
    'id', '${invoiceId}', 'clientId', '${clientId}', 'projectId', '${projectId}',
    'invoiceNumber', '${invoiceNumber}', 'currency', 'EGP',
    'items', jsonb_build_array(jsonb_build_object('description', 'Synthetic service', 'quantity', 2, 'unitPrice', 500)),
    'discount', 100, 'tax', 10, 'status', 'Issued',
    'issueDate', current_date, 'dueDate', current_date + 7,
    'createdAt', now()
  ), target_organization_id);

  select id into canonical_invoice_id
  from public.finance_invoices
  where organization_id = target_organization_id and legacy_record_id = '${invoiceId}'
    and deleted_at is null;
  if canonical_invoice_id is null then raise exception 'canonical invoice projection failed'; end if;
  if (select subtotal from public.finance_invoices where id = canonical_invoice_id) <> 1000 then
    raise exception 'invoice subtotal mismatch';
  end if;
  if (select total from public.finance_invoices where id = canonical_invoice_id) <> 990 then
    raise exception 'invoice total mismatch';
  end if;
  if (select relationship_state from public.finance_invoices where id = canonical_invoice_id) <> 'VALID' then
    raise exception 'invoice relationship state mismatch';
  end if;

  insert into public.records(id, coll, data, organization_id)
  values ('${paymentId}', 'payments', jsonb_build_object(
    'id', '${paymentId}', 'paymentNumber', '${paymentNumber}',
    'invoiceId', '${invoiceId}', 'amount', 300, 'method', 'Bank Transfer',
    'date', current_date, 'reference', 'SYNTHETIC-M7',
    'attachment', 'https://example.invalid/synthetic-receipt',
    'createdBy', 'M7 staging canary', 'createdAt', now()
  ), target_organization_id);

  if (select count(*) from public.finance_payments
      where organization_id = target_organization_id and legacy_record_id = '${paymentId}'
        and invoice_id = canonical_invoice_id and client_account_id = canonical_client_id
        and amount = 300 and deleted_at is null) <> 1 then
    raise exception 'canonical payment relationship mismatch';
  end if;
  if (select data->>'clientId' from public.records where id = '${paymentId}') <> '${clientId}' then
    raise exception 'payment client was not derived from invoice';
  end if;

  invoice_result := public.get_finance_workspace(
    target_organization_id, 'Invoices', '${invoiceNumber}', null,
    '${clientId}', null, null, 1, 25
  );
  if (invoice_result->>'total')::integer <> 1 then raise exception 'invoice workspace filter failed'; end if;
  invoice_item := invoice_result->'items'->0;
  if invoice_item->>'invoiceNumber' <> '${invoiceNumber}' then raise exception 'invoice workspace item mismatch'; end if;
  if (invoice_item->>'total')::numeric <> 990 then raise exception 'workspace total mismatch'; end if;
  if (invoice_item->>'paid')::numeric <> 300 then raise exception 'workspace paid mismatch'; end if;
  if (invoice_item->>'remaining')::numeric <> 690 then raise exception 'workspace remaining mismatch'; end if;
  if invoice_item->>'status' <> 'Partially Paid' then raise exception 'automatic invoice status mismatch'; end if;

  payment_result := public.get_finance_workspace(
    target_organization_id, 'Payments', '${paymentNumber}', null,
    '${clientId}', null, null, 1, 25
  );
  if (payment_result->>'total')::integer <> 1 then raise exception 'payment workspace filter failed'; end if;
  payment_item := payment_result->'items'->0;
  if payment_item->>'invoiceNumber' <> '${invoiceNumber}' then raise exception 'payment invoice link mismatch'; end if;
  if payment_item->>'clientId' <> '${clientId}' then raise exception 'payment client link mismatch'; end if;
  if payment_item->>'reference' <> 'SYNTHETIC-M7' then raise exception 'payment audit reference mismatch'; end if;

  if has_function_privilege(
    'anon',
    'public.get_finance_workspace(uuid,text,text,text,text,date,date,integer,integer)',
    'EXECUTE'
  ) then raise exception 'anon Finance V2 execute leak'; end if;

  select membership.user_id into limited_user_id
  from public.organization_members membership
  join public.organization_roles role on role.id = membership.role_id
  join public.profiles profile on profile.id = membership.user_id
  where membership.organization_id = target_organization_id
    and membership.status = 'ACTIVE'
    and profile.identity_status = 'ACTIVE'
    and role.key in ('content_creator', 'designer')
  limit 1;
  if limited_user_id is null then raise exception 'missing limited Staging member'; end if;
  perform set_config('request.jwt.claim.sub', limited_user_id::text, true);
  begin
    perform public.get_finance_workspace(target_organization_id, 'Invoices', null, null, null, null, null, 1, 25);
  exception when insufficient_privilege then
    rejected_limited_role := true;
  end;
  if not rejected_limited_role then raise exception 'limited role could read Finance V2'; end if;
end $test$;
rollback;`;

try {
  cli(['db', 'query', '--linked', '--project-ref', projectRef, '--output', 'json', sql]);
  process.stdout.write('Finance V2 Staging E2E: 22 passed, 0 failed. Transaction rolled back.\n');
} catch (error) {
  console.error('Finance V2 Staging E2E failed: ' + safe(error.message || error));
  process.exit(1);
}
