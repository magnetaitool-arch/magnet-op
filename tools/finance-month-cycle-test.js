#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function same(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)})`);
}

const start = app.indexOf('// MAGNET_FINANCE_MONTH_CORE_START');
const end = app.indexOf('// MAGNET_FINANCE_MONTH_CORE_END');
if (start < 0 || end < start) throw new Error('Finance month core markers are missing.');
const core = app.slice(start, end);
const context = { console };
vm.createContext(context);
vm.runInContext(`
  const todayISO=()=> '2026-09-06';
  const nowISO=()=> '2026-09-06T12:00:00.000Z';
  const monthOf=(value)=>String(value||'').slice(0,7);
  const thisMonth=()=>todayISO().slice(0,7);
  ${core}
  globalThis.financeMonthTestAPI={
    shiftMonthISO, periodEndISO, invoiceAccountingMonth, paymentAccountingMonth,
    expenseAccountingMonth, invoicePaidThroughPeriod, invoiceOutstandingAtPeriodEnd,
    invoiceIssuedByPeriod, invoiceOverdueAtPeriodEnd, fixedCostAppliesToMonth,
    fixedCostDueInMonth, fixedCostMonthlyAmount, fixedCostDueAmount,
    fixedCostStateForMonth, prepareFixedCostUpdate
  };
`, context);
const f = context.financeMonthTestAPI;

console.log('[1] accounting period navigation');
same(f.shiftMonthISO('2026-01', -1), '2025-12', 'previous month crosses the year boundary');
same(f.shiftMonthISO('2026-12', 1), '2027-01', 'next month crosses the year boundary');
same(f.periodEndISO('2028-02'), '2028-02-29', 'period end supports leap years');
check(/function MonthPeriodControl\(/.test(app), 'shared month selector exists');
check(/type="month"[\s\S]{0,160}max=\$\{current\}/.test(app), 'future periods cannot be selected');
check(/period!==current[\s\S]{0,220}onChange\(current\)/.test(app), 'users can return to the current month');

console.log('\n[2] one canonical month per finance record');
const invoice = { id:'inv-1', amount:100, issueDate:'2026-08-05', dueDate:'2026-09-10', createdAt:'2026-08-06T10:00:00Z', updatedAt:'2026-10-01T10:00:00Z' };
same(f.invoiceAccountingMonth(invoice), '2026-08', 'invoice belongs to its issue month only');
same(f.paymentAccountingMonth({date:'2026-09-02', paidAt:'2026-10-02T10:00:00Z', createdAt:'2026-08-01'}), '2026-09', 'payment belongs to its explicit payment month only');
same(f.expenseAccountingMonth({date:'2026-07-31', updatedAt:'2026-09-01'}), '2026-07', 'expense updates do not move its accounting month');

console.log('\n[3] historical outstanding is period-end accurate');
const db = { payments:[
  {id:'pay-aug', invoiceId:'inv-1', amount:20, date:'2026-08-20'},
  {id:'pay-sep', invoiceId:'inv-1', amount:30, date:'2026-09-20'},
  {id:'pay-oct', invoiceId:'inv-1', amount:50, date:'2026-10-03'}
] };
same(f.invoicePaidThroughPeriod(db, invoice, '2026-08'), 20, 'August sees only payments received by August end');
same(f.invoiceOutstandingAtPeriodEnd(db, invoice, '2026-08'), 80, 'later payments never rewrite August outstanding');
same(f.invoiceOutstandingAtPeriodEnd(db, invoice, '2026-09'), 50, 'September outstanding includes payments through September');
same(f.invoiceOutstandingAtPeriodEnd(db, invoice, '2026-10'), 0, 'October closes the invoice after the final payment');
check(!f.invoiceIssuedByPeriod(invoice, '2026-07') && f.invoiceIssuedByPeriod(invoice, '2026-08'), 'invoice enters reports only after it is issued');
check(f.invoiceOverdueAtPeriodEnd({payments:[]}, invoice, '2026-09'), 'unpaid invoice is overdue at September end');
check(!f.invoiceOverdueAtPeriodEnd(db, invoice, '2026-10'), 'fully paid invoice is not overdue');

console.log('\n[4] recurring and one-time schedules');
const monthly = {id:'fc-m', amount:120, cycle:'Monthly', status:'Active', startDate:'2026-07-01'};
const quarterly = {id:'fc-q', amount:300, cycle:'Quarterly', status:'Active', startDate:'2026-07-01'};
const yearly = {id:'fc-y', amount:1200, cycle:'Yearly', status:'Active', startDate:'2026-07-01'};
const once = {id:'fc-o', amount:500, cycle:'One-time', status:'Active', startDate:'2026-07-15'};
check(f.fixedCostDueInMonth(monthly, '2026-08'), 'monthly cost is due every active month');
check(f.fixedCostDueInMonth(quarterly, '2026-07') && !f.fixedCostDueInMonth(quarterly, '2026-08') && f.fixedCostDueInMonth(quarterly, '2026-10'), 'quarterly cost follows a three-month schedule');
check(f.fixedCostDueInMonth(yearly, '2026-07') && !f.fixedCostDueInMonth(yearly, '2026-08') && f.fixedCostDueInMonth(yearly, '2027-07'), 'yearly cost follows a twelve-month schedule');
check(f.fixedCostDueInMonth(once, '2026-07') && !f.fixedCostAppliesToMonth(once, '2026-08'), 'one-time cost never repeats next month');
same(f.fixedCostMonthlyAmount(quarterly, '2026-08'), 100, 'quarterly cost accrues evenly for profitability');
same(f.fixedCostDueAmount(quarterly, '2026-08'), 0, 'quarterly cash payment is zero in a non-due month');
same(f.fixedCostDueAmount(quarterly, '2026-10'), 300, 'quarterly cash payment uses the full amount when due');

console.log('\n[5] edits and pauses preserve prior months');
const edited = f.prepareFixedCostUpdate(monthly, {...monthly, amount:180}, '2026-09', '2026-09-06T12:00:00.000Z');
same(f.fixedCostStateForMonth(edited, '2026-07').amount, 120, 'July keeps the amount that applied then');
same(f.fixedCostStateForMonth(edited, '2026-08').amount, 120, 'August keeps the amount that applied then');
same(f.fixedCostStateForMonth(edited, '2026-09').amount, 180, 'the edited amount begins in the current month');
const paused = f.prepareFixedCostUpdate(edited, {...edited, status:'Paused'}, '2026-09', '2026-09-20T12:00:00.000Z');
check(f.fixedCostAppliesToMonth(paused, '2026-09'), 'paused item remains in the month it was paused');
check(!f.fixedCostAppliesToMonth(paused, '2026-10'), 'paused item does not create a new charge next month');
const resumed = f.prepareFixedCostUpdate(paused, {...paused, status:'Active'}, '2026-10', '2026-10-02T12:00:00.000Z');
check(f.fixedCostAppliesToMonth(resumed, '2026-10'), 'resuming reopens the recurring item without losing history');

console.log('\n[6] per-month payment, settlement and archive UI');
check(/paidMonths:Array\.from\(new Set/.test(app), 'monthly payment marks are idempotent');
check(/const settledMonths=Array\.from\(new Set/.test(app), 'monthly settlement marks are idempotent');
check(/settlementMonth\(r\)===period/.test(app), 'settlement history is isolated by month');
check(/add\('Fixed cost'/.test(app) && /add\('Partner settlement'/.test(app), 'month archive includes fixed costs and settlements');
check(/monthly rollover never deletes records/i.test(app), 'monthly rollover remains non-destructive');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
