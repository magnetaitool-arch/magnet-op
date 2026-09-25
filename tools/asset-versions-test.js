'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { versionedHtml } = require('./asset-versions');
test('changing module or stylesheet content changes its cache key; unchanged content stays stable', () => {
  const source =
    '<script src="/modules/client-onboarding.js?v=1"></script><link href="/styles/foundation.css?v=8"><script src="https://example.invalid/a.js"></script>';
  const first = versionedHtml(source, () => Buffer.from('one'));
  assert.equal(
    versionedHtml(first, () => Buffer.from('one')),
    first,
  );
  const changed = versionedHtml(first, (file) =>
    Buffer.from(file.endsWith('.css') ? 'two' : 'one'),
  );
  assert.notEqual(changed, first);
  assert.equal(first.match(/src="([^"]+)/)[1], changed.match(/src="([^"]+)/)[1]);
  assert.ok(changed.includes('https://example.invalid/a.js'));
  assert.throws(
    () =>
      versionedHtml('<script src="/modules/../secrets.js"></script>', () => Buffer.from('secret')),
    /Unpackaged asset/,
  );
});
