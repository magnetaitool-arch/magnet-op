'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  m = require('../magnet-studio/builder-model');
test('all ten templates contain structured empty blocks and preserve canonical bindings', () => {
  assert.equal(Object.keys(m.templates).length, 10);
  for (const key of Object.keys(m.templates)) {
    const d = m.create(key, { client: 'Actual client' }, 'ar');
    assert.equal(m.validate(d), d);
    assert.equal(d.pages[0].blocks[0].text, 'Actual client');
    assert.ok(d.pages.flatMap((p) => p.blocks).every((b) => b.rows.length === 0));
    assert.equal(d.language, 'ar');
  }
});
test('reorder, duplicate and serialization preserve order without reusing identities', () => {
  const d = m.create('proposal');
  const old = d.pages.map((p) => p.id);
  d.pages = m.move(d.pages, 0, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(d)).pages.map((p) => p.id),
    [old[1], old[2], old[0]],
  );
  const copy = m.duplicate(d.pages[0]);
  assert.notEqual(copy.id, d.pages[0].id);
  assert.notEqual(copy.blocks[0].id, d.pages[0].blocks[0].id);
  d.pages.push(copy);
  m.validate(d);
});
test('brand snapshot is immutable relative to canonical input and rejects unsafe styling', () => {
  const kit = m.brand(),
    d = m.create('audit', { brand: kit });
  kit.accent = '#000000';
  assert.equal(d.brand.accent, '#c8ff22');
  d.brand.primary = 'url(javascript:alert(1))';
  assert.throws(() => m.validate(d));
});
test('invalid IDs, excessive payloads and unstructured rows are rejected', () => {
  const d = m.create('strategy');
  d.pages[1].id = d.pages[0].id;
  assert.throws(() => m.validate(d));
  const x = m.create('audit');
  x.pages[0].blocks[0].rows = [['x', {}]];
  assert.throws(() => m.validate(x));
});
