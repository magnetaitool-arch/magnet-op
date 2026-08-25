#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825230000_finance_v2.sql');
const app = read('index.html');
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

console.log('[1] canonical finance model');
check(/create table if not exists public\.finance_invoices/.test(migration), 'creates canonical invoices');
check(/create table if not exists public\.finance_payments/.test(migration), 'creates canonical payments');
check(/foreign key \(organization_id, client_account_id\)/.test(migration), 'invoice and payment clients are tenant-bound');
check(/foreign key \(organization_id, invoice_id\)/.test(migration), 'payments belong to a canonical invoice');
check(/payment_invoice_required/.test(migration) && /payment_invoice_not_found/.test(migration), 'new loose payments are rejected');
check(/invoice_project_or_contract_required/.test(migration), 'new invoices require a project or contract');
check(/finance_invoice_subtotal/.test(migration) && /finance_invoice_total/.test(migration), 'invoice totals are calculated server-side');
check(/M7 projection mismatch/.test(migration), 'legacy projection counts are validated');
check(!/delete from public\.records/i.test(migration), 'migration never deletes legacy records');

console.log('\n[2] access and data quality');
check(/has_org_capability\(p_organization_id, 'finance\.read'\)/.test(migration), 'finance reads require live capability');
check(/revoke all on function public\.get_finance_workspace[\s\S]*from public, anon/.test(migration), 'anonymous users cannot call Finance V2');
check(/create table if not exists public\.finance_projection_issues/.test(migration), 'historical relationship issues are quarantined');
check(/MISSING_OR_INVALID_INVOICE/.test(migration), 'invalid historical payments are explicitly classified');
check(/finance_projection_issues_manager_read/.test(migration), 'issue inventory is manager-only');
check(/finance_invoice_effective_status/.test(migration), 'effective payment and overdue status is automatic');

console.log('\n[3] Finance V2 UX');
check(/function FinanceWorkspaceView\(/.test(app), 'dedicated Finance V2 workspace exists');
for (const tab of ['Invoices','Payments','Expenses','Payroll','Contracts']) {
  check(app.includes(`'${tab}'`), `workspace includes ${tab}`);
}
for (const metric of ['Revenue','Collected','Outstanding','Overdue','Expenses','Net']) {
  check(app.includes(`'${metric}'`), `dashboard includes ${metric}`);
}
check(/get_finance_workspace/.test(app), 'workspace reads through tenant-explicit RPC');
check(/downloadFinanceCSV/.test(app), 'filtered results can be exported');
check(/p_from_date/.test(app) && /p_to_date/.test(app) && /p_legacy_client_id/.test(app), 'date and client filters are server-side');
check(/contractId[\s\S]*projectId/.test(app), 'invoice form exposes the contract/project relationship');
check(/paymentNumber/.test(app) && /reference/.test(app) && /attachment/.test(app), 'payment form includes audit fields');
check(/financeStatusType/.test(app) && /finance-metric\.overdue/.test(app), 'semantic finance colors are present');
check(/workspace-relations/.test(app), 'client to payment relationship is visible');
check(/@media\(max-width:767px\)[^{]*\{[^}]*\.finance-summary/.test(app), 'finance workspace has a mobile layout');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
