'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Analyze a logical snapshot without mutating it or guessing repairs. */
function reconcile(snapshot) {
  if (
    snapshot?.format !== 'magnet-os-m0-logical-backup' ||
    !snapshot.publicData ||
    !snapshot.schemaInventory ||
    !Array.isArray(snapshot.publicData.records) ||
    !Array.isArray(snapshot.schemaInventory.columns) ||
    !Array.isArray(snapshot.schemaInventory.constraints) ||
    !Array.isArray(snapshot.authInventory?.users) ||
    !Array.isArray(snapshot.storageInventory?.objects) ||
    !Array.isArray(snapshot.storageInventory?.buckets)
  )
    throw new Error('A complete M0 logical snapshot is required');
  const tables = Object.fromEntries(
    Object.entries(snapshot.publicData).map(([key, rows]) => ['public.' + key, rows]),
  );
  tables['auth.users'] = snapshot.authInventory?.users || [];
  tables['storage.objects'] = snapshot.storageInventory?.objects || [];
  tables['storage.buckets'] = snapshot.storageInventory?.buckets || [];
  const issues = [];
  const uncovered = [];
  const identity = (row) => row.id ?? row.record_id ?? row.auth_user_id ?? row.version ?? null;
  const issue = (code, table, row, detail) =>
    issues.push({ code, table, row: identity(row), detail });
  const key = (row, cols) => JSON.stringify(cols.map((col) => row[col]));
  const columns = (raw) => raw.split(',').map((s) => s.trim().replaceAll('"', ''));
  const indexes = new Map();
  const indexed = (table, cols) => {
    const name = table + ':' + cols.join(',');
    if (!indexes.has(name))
      indexes.set(name, new Set((tables[table] || []).map((row) => key(row, cols))));
    return indexes.get(name);
  };
  let foreignKeysChecked = 0,
    uniqueConstraintsChecked = 0,
    requiredColumnsChecked = 0;
  for (const col of snapshot.schemaInventory.columns || []) {
    const table = `${col.schema_name}.${col.table_name}`;
    if (!col.not_null || !tables[table]) continue;
    requiredColumnsChecked++;
    for (const row of tables[table])
      if (row[col.column_name] === null || row[col.column_name] === undefined)
        issue('required_field_missing', table, row, { column: col.column_name });
  }
  for (const constraint of snapshot.schemaInventory.constraints || []) {
    const table = `${constraint.schema_name}.${constraint.table_name}`;
    if (!tables[table]) continue;
    if (constraint.constraint_type === 'f') {
      const match = /^FOREIGN KEY \(([^)]+)\) REFERENCES ([\w."-]+)\(([^)]+)\)/.exec(
        constraint.definition,
      );
      if (!match) {
        uncovered.push({
          constraint: constraint.constraint_name,
          reason: 'unsupported_foreign_key_definition',
        });
        continue;
      }
      const from = columns(match[1]),
        to = columns(match[3]);
      let parent = match[2].replaceAll('"', '');
      if (!parent.includes('.')) parent = 'public.' + parent;
      if (!tables[parent]) {
        uncovered.push({
          constraint: constraint.constraint_name,
          reason: 'parent_not_exported',
          parent,
        });
        continue;
      }
      foreignKeysChecked++;
      const parents = indexed(parent, to);
      for (const row of tables[table]) {
        if (from.some((col) => row[col] === null || row[col] === undefined)) continue; // PostgreSQL MATCH SIMPLE semantics
        if (!parents.has(JSON.stringify(from.map((col) => row[col]))))
          issue('foreign_key_orphan', table, row, {
            constraint: constraint.constraint_name,
            parent,
            columns: from,
          });
      }
    } else if (['p', 'u'].includes(constraint.constraint_type)) {
      const match = /^(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)/.exec(constraint.definition);
      if (!match) {
        uncovered.push({
          constraint: constraint.constraint_name,
          reason: 'unsupported_unique_definition',
        });
        continue;
      }
      uniqueConstraintsChecked++;
      const cols = columns(match[1]),
        seen = new Set();
      for (const row of tables[table]) {
        if (cols.some((col) => row[col] === null || row[col] === undefined)) continue;
        const value = key(row, cols);
        if (seen.has(value))
          issue('duplicate_database_key', table, row, {
            constraint: constraint.constraint_name,
            columns: cols,
          });
        seen.add(value);
      }
    }
  }
  const records = tables['public.records'] || [];
  const active = (row) => !row.deleted_at && ![true, 'true'].includes(row.data?._del);
  const byCollection = new Map();
  for (const row of records) {
    if (!byCollection.has(row.coll)) byCollection.set(row.coll, new Map());
    byCollection.get(row.coll).set(row.id, row);
    if (!row.organization_id)
      issue('tenant_missing', 'public.records', row, { collection: row.coll });
  }
  const relationships = {
    clients: { accountManager: 'employees', projectManager: 'employees' },
    contacts: { clientId: 'clients', leadId: 'leads' },
    leads: { clientId: 'clients' },
    projects: { clientId: 'clients' },
    briefs: { clientId: 'clients', projectId: 'projects' },
    tasks: {
      clientId: 'clients',
      projectId: 'projects',
      assignedTo: 'employees',
      deliverableId: 'deliverables',
    },
    deliverables: { clientId: 'clients', projectId: 'projects' },
    revisions: { taskId: 'tasks', deliverableId: 'deliverables' },
    proposals: { clientId: 'clients', leadId: 'leads' },
    quotations: { clientId: 'clients', leadId: 'leads' },
    contracts: { clientId: 'clients' },
    invoices: { clientId: 'clients' },
    payments: { clientId: 'clients', invoiceId: 'invoices' },
    salesActivities: { leadId: 'leads', clientId: 'clients' },
    clientAssets: { clientId: 'clients' },
    files: { clientId: 'clients', projectId: 'projects' },
    reports: { clientId: 'clients' },
    campaigns: { clientId: 'clients' },
    meetings: { clientId: 'clients', projectId: 'projects' },
  };
  for (const row of records.filter(active)) {
    for (const [field, parentCollection] of Object.entries(relationships[row.coll] || {})) {
      const value = row.data?.[field];
      if (value === null || value === undefined || value === '') continue;
      const parent = byCollection.get(parentCollection)?.get(value);
      if (!parent)
        issue('legacy_reference_unresolved', 'public.records', row, {
          collection: row.coll,
          field,
          parentCollection,
        });
      else if (parent.organization_id !== row.organization_id)
        issue('cross_tenant_reference', 'public.records', row, {
          collection: row.coll,
          field,
          parentCollection,
        });
      else if (!active(parent))
        issue('active_child_deleted_parent', 'public.records', row, {
          collection: row.coll,
          field,
          parentCollection,
        });
    }
  }
  // Shared contact details are candidates for review, not proof of duplicate identity.
  for (const [collection, field] of Object.entries({
    clients: 'mainContactEmail',
    leads: 'email',
    contacts: 'email',
    employees: 'email',
  })) {
    const groups = new Map();
    for (const row of byCollection.get(collection)?.values() || []) {
      if (!active(row)) continue;
      const value = String(row.data?.[field] || '')
        .trim()
        .toLowerCase();
      if (!value) continue;
      const group = JSON.stringify([row.organization_id, value]);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(row);
    }
    for (const rows of groups.values())
      if (rows.length > 1)
        for (const row of rows)
          issue('shared_contact_identity_requires_review', 'public.records', row, {
            collection,
            field,
            groupSize: rows.length,
          });
  }
  const projections = {
    clients: 'client_accounts',
    leads: 'crm_leads',
    tasks: 'work_tasks',
    invoices: 'finance_invoices',
    payments: 'finance_payments',
    contracts: 'agency_contracts',
    candidates: 'applicants',
  };
  const projectionCounts = {};
  for (const [collection, table] of Object.entries(projections)) {
    const legacy = [...(byCollection.get(collection)?.values() || [])],
      canonical = tables['public.' + table] || [];
    const mapped = new Map();
    for (const row of canonical) {
      const id = row.legacy_record_id;
      if (mapped.has(id)) issue('duplicate_projection', 'public.' + table, row, { collection });
      mapped.set(id, row);
      const source = byCollection.get(collection)?.get(id);
      if (!source) issue('projection_source_missing', 'public.' + table, row, { collection });
      else if (source.organization_id !== row.organization_id)
        issue('projection_tenant_mismatch', 'public.' + table, row, { collection });
      else if (active(source) !== !row.deleted_at)
        issue('projection_deletion_mismatch', 'public.' + table, row, { collection });
    }
    for (const row of legacy.filter(active))
      if (!mapped.has(row.id))
        issue('active_projection_missing', 'public.records', row, { collection, target: table });
    projectionCounts[collection] = {
      legacy: legacy.length,
      legacyActive: legacy.filter(active).length,
      canonical: canonical.length,
      canonicalActive: canonical.filter((row) => !row.deleted_at).length,
    };
  }
  const tenantMaps = new Map(
    (tables['public.legacy_record_tenant_map'] || []).map((row) => [row.record_id, row]),
  );
  for (const row of records) {
    const mapping = tenantMaps.get(row.id);
    if (!mapping || mapping.organization_id !== row.organization_id)
      issue('tenant_mapping_mismatch', 'public.records', row, { collection: row.coll });
  }
  const authIds = new Set((tables['auth.users'] || []).map((row) => row.id));
  for (const row of tables['public.profiles'] || [])
    if (!authIds.has(row.id)) issue('profile_auth_missing', 'public.profiles', row, {});
  const links = tables['public.legacy_identity_links'] || [];
  for (const account of byCollection.get('_accounts')?.values() || []) {
    if (!active(account)) continue;
    const matches = links.filter((link) => link.legacy_account_row_id === account.id);
    if (matches.length !== 1 || !authIds.has(matches[0]?.auth_user_id))
      issue('legacy_identity_requires_review', 'public.records', account, {
        mappingCount: matches.length,
      });
  }
  const employeeUsers = new Map();
  for (const [employee, userId] of [
    ...(tables['public.profiles'] || []).map((row) => [row.employee_id, row.id]),
    ...links
      .filter((row) => row.link_status === 'CONFIRMED')
      .map((row) => [row.employee_record_id, row.auth_user_id]),
  ]) {
    if (!employee || !userId) continue;
    if (!employeeUsers.has(employee)) employeeUsers.set(employee, new Set());
    employeeUsers.get(employee).add(userId);
  }
  for (const [employee, users] of employeeUsers) {
    if (users.size > 1)
      issue(
        'ambiguous_employee_user_mapping',
        'public.records',
        { id: employee },
        { userCount: users.size },
      );
    if (!byCollection.get('employees')?.has(employee))
      issue('identity_employee_missing', 'public.records', { id: employee }, {});
  }
  const members = tables['public.organization_members'] || [];
  for (const row of tables['public.work_tasks'] || []) {
    if (row.deleted_at || !row.assigned_user_id) continue;
    const member = members.find(
      (item) =>
        item.organization_id === row.organization_id && item.user_id === row.assigned_user_id,
    );
    if (!member) issue('assigned_user_without_tenant_membership', 'public.work_tasks', row, {});
    else if (member.status !== 'ACTIVE')
      issue('assigned_user_membership_inactive', 'public.work_tasks', row, {});
  }
  const objects = tables['storage.objects'],
    objectKeys = new Set(objects.map((row) => JSON.stringify([row.bucket_id, row.name]))),
    referenced = new Set();
  for (const row of tables['public.document_files'] || [])
    for (const field of ['original_path', 'optimized_path', 'thumbnail_path']) {
      if (!row[field]) continue;
      const object = JSON.stringify([row.bucket_id, row[field]]);
      referenced.add(object);
      if (['ACTIVE', 'ARCHIVED'].includes(row.status) && !objectKeys.has(object))
        issue('document_object_missing', 'public.document_files', row, { field });
    }
  // This is a review candidate: other legacy domains may own the object.
  for (const row of objects)
    if (!referenced.has(JSON.stringify([row.bucket_id, row.name])))
      issue('object_outside_document_catalog', 'storage.objects', row, { bucket: row.bucket_id });
  const issueLedgers = {};
  const recordById = new Map(records.map((row) => [row.id, row]));
  for (const name of [
    'task_projection_issues_v2',
    'finance_projection_issues',
    'document_import_issues',
    'contract_projection_issues',
  ]) {
    const summary = { unresolved: 0, activeSource: 0, byCode: {} };
    for (const row of tables['public.' + name] || []) {
      if (row.resolved_at) continue;
      summary.unresolved++;
      const source = recordById.get(row.legacy_record_id);
      if (source && active(source)) summary.activeSource++;
      summary.byCode[row.issue_code] = (summary.byCode[row.issue_code] || 0) + 1;
    }
    issueLedgers[name] = summary;
  }
  const issueCounts = {};
  for (const item of issues) issueCounts[item.code] = (issueCounts[item.code] || 0) + 1;
  const collections = {};
  for (const [name, rows] of byCollection)
    collections[name] = { total: rows.size, active: [...rows.values()].filter(active).length };
  const rowHashes = {};
  const canonicalize = (value) =>
    Array.isArray(value)
      ? value.map(canonicalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, canonicalize(value[k])]),
          )
        : value;
  for (const [name, rows] of Object.entries(tables))
    rowHashes[name] = rows
      .map((row) =>
        crypto
          .createHash('sha256')
          .update(JSON.stringify(canonicalize(row)))
          .digest('hex'),
      )
      .sort();
  return {
    format: 'magnet-reconciliation-v1',
    sourceProjectRef: snapshot.sourceProjectRef,
    snapshotAt: snapshot.completedAt,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    collections,
    projectionCounts,
    issueLedgers,
    issueCounts,
    issues,
    coverage: {
      foreignKeysChecked,
      uniqueConstraintsChecked,
      requiredColumnsChecked,
      uncovered,
      limitations: [
        'CHECK expressions and partial/expression unique indexes require PostgreSQL validation',
        'Legacy references are explicit reviewed field mappings, not inferred associations',
        'No object-byte checksums, provider HTTP checks or end-to-end workflow proof',
        'Snapshot may span concurrent writes; findings require a consistent staging rehearsal',
      ],
    },
    rowHashes,
  };
}
function compare(before, after) {
  if (before.sourceProjectRef !== after.sourceProjectRef)
    throw new Error(
      'Snapshots belong to different projects; explicit staging provenance mapping required',
    );
  const changedTables = [];
  for (const table of new Set([
    ...Object.keys(before.rowHashes),
    ...Object.keys(after.rowHashes),
  ])) {
    const left = before.rowHashes[table] || [],
      right = after.rowHashes[table] || [];
    if (JSON.stringify(left) !== JSON.stringify(right))
      changedTables.push({ table, before: left.length, after: right.length });
  }
  return {
    format: 'magnet-reconciliation-comparison-v1',
    changedTables,
    beforeIssueCounts: before.issueCounts,
    afterIssueCounts: after.issueCounts,
    unresolvedFindings: after.issues.length,
    releaseReady: false,
    requiresReview: changedTables.length > 0,
    conclusion: changedTables.length
      ? 'Data changed; per-entity mapping and approved transformations must be verified'
      : 'Exported row values match; application and storage behavior still require verification',
  };
}
if (require.main === module) {
  const [input, output, after] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      'Usage: node tools/reconcile-data.js snapshot.json backups/report-directory [after-snapshot.json]',
    );
  const out = path.resolve(output),
    root = path.resolve(__dirname, '../backups');
  if (!out.startsWith(root + path.sep))
    throw new Error('Reports must be stored in the private gitignored backups directory');
  if (fs.existsSync(out))
    throw new Error('Choose a new report directory; existing reports are immutable');
  let parent = path.dirname(out);
  while (parent !== root) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink())
      throw new Error('Symlink report path rejected');
    parent = path.dirname(parent);
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Symlink backup root rejected');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  fs.chmodSync(out, 0o700);
  const report = reconcile(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(path.join(out, 'reconciliation.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  if (after)
    fs.writeFileSync(
      path.join(out, 'comparison.json'),
      JSON.stringify(
        compare(report, reconcile(JSON.parse(fs.readFileSync(after, 'utf8')))),
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  console.log(
    JSON.stringify({ counts: report.issueCounts, coverage: report.coverage, report: out }, null, 2),
  );
}
module.exports = { reconcile, compare };
