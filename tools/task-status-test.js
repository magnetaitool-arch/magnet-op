'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { changeLegacyTaskStatus } = require('../modules/task-status');
test('legacy task status commits only verified server data; failures keep prior UI data', async () => {
  const record = { id: 'task', status: 'In Progress', title: 'Stored title' },
    committed = [];
  const base = {
    organizationId: 'tenant',
    record,
    updates: { status: 'Done', completedAt: 'forged', completedBy: 'forged' },
    onCommitted: (r) => committed.push(r),
  };
  await changeLegacyTaskStatus({
    ...base,
    rpc: async (name, args) => {
      assert.equal(name, 'change_task_record_status_v2');
      assert.equal(args.p_expected_status, 'In Progress');
      assert.equal('completedAt' in args, false);
      return { ok: true, record: { ...record, status: 'Done', completedBy: 'server-user' } };
    },
  });
  assert.equal(committed.length, 1);
  assert.equal(committed[0].completedBy, 'server-user');
  assert.equal(record.status, 'In Progress');
  for (const rpc of [
    async () => {
      throw Error('network failure');
    },
    async () => ({ ok: false }),
    async () => ({ ok: true, record: { id: 'other', status: 'Done' } }),
  ])
    await assert.rejects(changeLegacyTaskStatus({ ...base, rpc }));
  assert.equal(committed.length, 1);
  await assert.rejects(
    changeLegacyTaskStatus({
      ...base,
      updates: { status: 'Done', title: 'Mixed edit' },
      rpc: () => {
        throw Error('should not call');
      },
    }),
    /separate_from_details/,
  );
});
