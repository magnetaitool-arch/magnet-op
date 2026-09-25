'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { STATIC_FILES } = require('./static-files');
const root = path.resolve(__dirname, '..');
/** @param {string} html @param {(file:string)=>Buffer} read */
function versionedHtml(html, read) {
  return html.replace(
    /((?:src|href)=")(\/(?:modules|styles)\/[^"?]+)(?:\?[^" ]*)?"/g,
    (_match, prefix, url) => {
      const file = url.slice(1);
      if (!STATIC_FILES.includes(file)) throw new Error('Unpackaged asset: ' + file);
      const hash = crypto.createHash('sha256').update(read(file)).digest('hex').slice(0, 16);
      return prefix + url + '?v=' + hash + '"';
    },
  );
}
function verifyAssetVersions(write = false) {
  const target = path.join(root, 'index.html'),
    current = fs.readFileSync(target, 'utf8');
  const expected = versionedHtml(current, (file) => fs.readFileSync(path.join(root, file)));
  if (current !== expected) {
    if (!write)
      throw new Error('Asset content versions are stale. Run pnpm run assets:update before build.');
    fs.writeFileSync(target, expected);
  }
  return true;
}
if (require.main === module) {
  verifyAssetVersions(process.argv.includes('--write'));
  console.log('Local module and stylesheet URLs match their content hashes.');
}
module.exports = { versionedHtml, verifyAssetVersions };
