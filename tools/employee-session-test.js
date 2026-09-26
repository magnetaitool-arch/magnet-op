'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('index.html', 'utf8');
const resolveSource = source.slice(
  source.indexOf('function resolveEmployee('),
  source.indexOf('// Every id/name'),
);
const resolve = new Function(resolveSource + ';return resolveEmployee;')();
const db = {
  employees: [
    { id: 'emp-real', userId: 'auth-real', fullName: 'Changed Name' },
    { id: 'emp-other', fullName: 'Same Name', email: 'same@example.invalid' },
  ],
};
test('canonical employee mapping survives different account IDs, names and emails', () => {
  assert.equal(
    resolve(
      {
        id: 'legacy-account',
        authUserId: 'auth-real',
        fullName: 'Same Name',
        email: 'same@example.invalid',
      },
      db,
    ).id,
    'emp-real',
  );
});
test('canonical identity without a linked employee never guesses from name or email', () => {
  assert.equal(
    resolve(
      {
        id: 'legacy-account',
        authUserId: 'auth-unlinked',
        fullName: 'Same Name',
        email: 'same@example.invalid',
      },
      db,
    ),
    null,
  );
});
test('explicit employee mapping and legacy-only lookup remain supported', () => {
  assert.equal(resolve({ employeeId: 'emp-real', authUserId: 'auth-real' }, db).id, 'emp-real');
  assert.equal(resolve({ email: 'same@example.invalid' }, db).id, 'emp-other');
});
test('login and logout attendance use the same canonical self-owned key', () => {
  const body = source.slice(
    source.indexOf('  const empKeyFor ='),
    source.indexOf('  const hhmm ='),
  );
  const keyFor = new Function('resolveEmployee', 'db', body + ';return empKeyFor;')(resolve, db);
  assert.equal(keyFor({ id: 'legacy-account', authUserId: 'auth-real' }).key, 'emp-real');
  assert.equal(keyFor({ id: 'legacy-account', authUserId: 'auth-unlinked' }).key, 'auth-unlinked');
  assert.equal(keyFor({ id: 'legacy-account' }, { employees: [] }).key, 'usr-legacy-account');
});

test('mandatory JWT cutover includes historical role aliases outside the optional cohort', () => {
  const fn = source.match(/function authV2AppliesTo\(user\)\{[^\n]+/)[0];
  const applies = (contract, user) => new Function('AUTH_V2', fn + ';return authV2AppliesTo;')(contract)(user);
  for (const role of ['Designer', 'Project Manager', 'Accountant', 'Graphic Designer', 'HR']) {
    assert.equal(applies({ required: true, enabled: true, roles: ['Owner'] }, { role }), true);
  }
  assert.equal(applies({ required: false, enabled: true, roles: ['Owner'] }, { role: 'Designer' }), false);
  assert.equal(applies({ required: false, enabled: true, roles: ['Owner'] }, { role: 'Owner' }), true);
  assert.equal(applies({ required: false, enabled: false, roles: [] }, { role: 'Owner' }), false);
  assert.equal(applies({ required: true, enabled: true, roles: [] }, null), false);
});
