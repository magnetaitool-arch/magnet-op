'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcile, compare } = require('./reconcile-data');
const { resolveLeadClient } = require('../modules/legacy-compatibility');
const fixture = () => ({
  format: 'magnet-os-m0-logical-backup',
  sourceProjectRef: 'synthetic',
  publicData: {
    organizations: [{ id: 'a' }, { id: 'b' }],
    records: [{ id: 'c', coll: 'clients', organization_id: 'a', data: {} }],
    client_accounts: [
      { id: 'uuid', legacy_record_id: 'c', organization_id: 'a', deleted_at: null },
    ],
    legacy_record_tenant_map: [{ record_id: 'c', organization_id: 'a' }],
  },
  schemaInventory: {
    columns: [
      { schema_name: 'public', table_name: 'client_accounts', column_name: 'id', not_null: true },
    ],
    constraints: [
      {
        schema_name: 'public',
        table_name: 'client_accounts',
        constraint_type: 'f',
        constraint_name: 'tenant_fk',
        definition: 'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT',
      },
      {
        schema_name: 'public',
        table_name: 'client_accounts',
        constraint_type: 'p',
        constraint_name: 'clients_pk',
        definition: 'PRIMARY KEY (id)',
      },
    ],
  },
  authInventory: { users: [] },
  storageInventory: { objects: [], buckets: [] },
});
test('valid mappings reconcile without mutating source; identical snapshots are not workflow proof', () => {
  const input = fixture(),
    before = JSON.stringify(input),
    report = reconcile(input);
  assert.deepEqual(report.issueCounts, {});
  assert.equal(report.coverage.foreignKeysChecked, 1);
  assert.equal(JSON.stringify(input), before);
  assert.equal(compare(report, reconcile(input)).requiresReview, false);
  assert.match(compare(report, report).conclusion, /behavior still require/);
});
test('detects required fields, duplicates, actual FK orphans and tenant mismatch', () => {
  const input = fixture();
  input.publicData.client_accounts.push(
    { id: 'uuid', legacy_record_id: 'c', organization_id: 'missing' },
    { id: null },
  );
  const report = reconcile(input);
  for (const code of [
    'required_field_missing',
    'duplicate_database_key',
    'foreign_key_orphan',
    'projection_tenant_mismatch',
  ])
    assert.ok(report.issueCounts[code]);
});
test('soft-deleted legacy rows do not produce false missing projections; active descendants are reviewed', () => {
  const input = fixture();
  input.publicData.records[0].data._del = true;
  input.publicData.client_accounts[0].deleted_at = '2026-01-01';
  input.publicData.records.push({
    id: 'task',
    coll: 'tasks',
    organization_id: 'a',
    data: { clientId: 'c' },
  });
  const report = reconcile(input);
  assert.equal(report.issueCounts.active_child_deleted_parent, 1);
  assert.equal(
    report.issues.filter(
      (i) => i.code === 'active_projection_missing' && i.detail.collection === 'clients',
    ).length,
    0,
  );
});
test('cross-tenant legacy reference and unmanaged storage are review candidates, never repair actions', () => {
  const input = fixture();
  input.publicData.records.push({
    id: 'project',
    coll: 'projects',
    organization_id: 'b',
    data: { clientId: 'c' },
  });
  input.storageInventory.objects.push({ id: 'obj', bucket_id: 'legacy', name: 'not-a-document' });
  const report = reconcile(input);
  assert.equal(report.issueCounts.cross_tenant_reference, 1);
  assert.equal(report.issueCounts.object_outside_document_catalog, 1);
  assert.equal(report.repairs, undefined);
});
test('same counts with changed field values cannot pass reconciliation', () => {
  const input = fixture(),
    before = reconcile(input);
  input.publicData.records[0].data.name = 'changed';
  const result = compare(before, reconcile(input));
  assert.equal(result.requiresReview, true);
  assert.deepEqual(result.changedTables, [{ table: 'public.records', before: 1, after: 1 }]);
  assert.throws(
    () => compare(before, { ...before, sourceProjectRef: 'another' }),
    /different projects/,
  );
});
test('partial export and SQL coverage gaps are reported, never treated as clean', () => {
  assert.throws(() => reconcile({}), /complete/);
  const input = fixture();
  input.schemaInventory.constraints[0].definition =
    'FOREIGN KEY (organization_id) REFERENCES missing_table(id)';
  assert.equal(reconcile(input).coverage.uncovered.length, 1);
});
test('conversion uses explicit links; matching email or phone and conflicting/deleted links require review', () => {
  const lead = { id: 'lead', email: 'Shared@Example.invalid' };
  assert.equal(resolveLeadClient(lead, []).status, 'create');
  assert.equal(
    resolveLeadClient(lead, [{ id: 'a', mainContactEmail: 'shared@example.invalid' }]).status,
    'review',
  );
  assert.deepEqual(resolveLeadClient(lead, [{ id: 'a', leadId: 'lead' }]), {
    status: 'match',
    clientId: 'a',
  });
  assert.equal(
    resolveLeadClient(lead, [
      { id: 'a', leadId: 'lead' },
      { id: 'b', leadId: 'lead' },
    ]).status,
    'review',
  );
  assert.equal(resolveLeadClient({ ...lead, convertedClientId: 'absent' }, []).status, 'review');
  assert.equal(resolveLeadClient(lead, [{ id: 'a', leadId: 'lead', _del: true }]).status, 'review');
});

test('contradictory link and archived client cannot be silently reused', () => {
  assert.equal(
    resolveLeadClient({ id: 'lead', convertedClientId: 'a' }, [{ id: 'a', leadId: 'another' }])
      .status,
    'review',
  );
  assert.equal(
    resolveLeadClient({ id: 'lead' }, [{ id: 'a', leadId: 'lead', status: 'Archived' }]).status,
    'review',
  );
});
test('the application cannot auto-prune history on admin login', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(!html.includes('rpc/prune_ephemeral_records'));
});

test('ambiguous employee mappings and assignments outside tenant membership are flagged', () => {
  const input = fixture();
  input.authInventory.users = [{ id: 'u1' }, { id: 'u2' }];
  input.publicData.profiles = [
    { id: 'u1', employee_id: 'employee' },
    { id: 'u2', employee_id: 'employee' },
  ];
  input.publicData.records.push({
    id: 'employee',
    coll: 'employees',
    organization_id: 'a',
    data: {},
  });
  input.publicData.work_tasks = [
    { id: 'work', legacy_record_id: 'unmapped-task', organization_id: 'a', assigned_user_id: 'u1' },
  ];
  const report = reconcile(input);
  assert.equal(report.issueCounts.ambiguous_employee_user_mapping, 1);
  assert.equal(report.issueCounts.assigned_user_without_tenant_membership, 1);
});
