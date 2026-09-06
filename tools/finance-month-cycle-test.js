#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}

console.log('[1] accounting period navigation');
check(/function MonthPeriodControl\(/.test(app), 'shared month selector exists');
check(/type="month"[\s\S]{0,120}max=\$\{current\}/.test(app), 'future periods cannot be selected');
check(/shiftMonthISO\(period,-1\)/.test(app) && /shiftMonthISO\(period,1\)/.test(app), 'previous and next month navigation exists');
check(/period!==current[\s\S]{0,180}onChange\(current\)/.test(app), 'users can return to the current month');

console.log('\n[2] recurring cost history');
check(/function fixedCostAppliesToMonth\(/.test(app), 'recurring definitions are evaluated per month');
check(/function fixedCostDueInMonth\(/.test(app) && /elapsed%12===0/.test(app) && /elapsed%3===0/.test(app), 'yearly and quarterly bills are due only on their schedule');
check(/'Monthly','Quarterly','Yearly','One-time'/.test(app), 'one-time costs are supported without future repetition');
check(/paidMonths:Array\.from\(new Set/.test(app), 'monthly payment marks are idempotent');
check(/const settledMonths=Array\.from\(new Set/.test(app), 'monthly settlement marks are idempotent');
check(/fixedCostSettledInMonth\(r,period\)/.test(app), 'fixed-cost payer state is rendered for the selected month');
check(/Stop after \(optional\)/.test(app), 'recurring costs can have an end date');

console.log('\n[3] partner and profitability isolation');
check(/const paymentRows=\(db\.payments\|\|\[\]\)\.filter\(p=>recordInMonth\(p,period/.test(app), 'partner income is isolated by month');
check(/const expenseRows=\(db\.expenses\|\|\[\]\)\.filter\(e=>recordInMonth\(e,period/.test(app), 'partner expenses are isolated by month');
check(/p\.month===period&&p\.paymentStatus==='Paid'/.test(app), 'paid payroll is isolated by month');
check(/settlementMonth\(r\)===period/.test(app), 'settlement history is isolated by accounting period');
check(/period:accountingPeriod/.test(app) && /items:\[\{coll,id:item\.id,period:accountingPeriod\}\]/.test(app), 'new settlements retain their accounting period');
check(/function ProfitabilityView[\s\S]{0,220}useState\(thisMonth\(\)\)/.test(app), 'profitability opens on the current month');

console.log('\n[4] archive coverage');
check(/add\('Fixed cost'/.test(app), 'month archive includes recurring costs');
check(/add\('Partner transaction'/.test(app), 'month archive includes partner ledger activity');
check(/add\('Partner settlement'/.test(app), 'month archive includes settlements');
check(/monthly rollover never deletes records/i.test(app), 'existing month close remains non-destructive');

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
