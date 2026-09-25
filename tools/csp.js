'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { STATIC_FILES } = require('./static-files');
const root = path.resolve(__dirname, '..');
/** Hash only the exact, committed inline scripts; never allow arbitrary inline execution. */
function scriptPolicy() {
  const hashes = new Set();
  for (const file of STATIC_FILES.filter((file) => file.endsWith('.html'))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc\s*=/.test(match[1]) && match[2].trim())
        hashes.add(
          "'sha256-" + crypto.createHash('sha256').update(match[2]).digest('base64') + "'",
        );
    }
  }
  return (
    "script-src 'self' https://www.youtube.com " +
    [...hashes].join(' ') +
    "; script-src-attr 'none'"
  );
}
function configuredPolicy() {
  /** @type {{headers:Array<{source:string,headers:Array<{key:string,value:string}>}>}} */
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const header = config.headers
    .find((group) => group.source === '/(.*)')
    ?.headers.find((header) => header.key === 'Content-Security-Policy');
  if (!header) throw new Error('CSP header missing');
  return { config, header };
}
function verifyPolicy() {
  const { header } = configuredPolicy();
  const directives = header.value.split(';').map((value) => value.trim());
  const expected = scriptPolicy()
    .split(';')
    .map((value) => value.trim());
  if (!expected.every((value) => directives.includes(value)))
    throw new Error(
      'CSP hashes are stale. Run pnpm run csp:update after reviewing script changes.',
    );
  if (
    directives.some(
      (value) =>
        /^script-src(?:-elem|-attr)? /.test(value) && /unsafe-inline|unsafe-eval/.test(value),
    )
  )
    throw new Error('Unsafe script policy');
  return header.value;
}
if (require.main === module) {
  if (process.argv.includes('--write')) {
    const { config, header } = configuredPolicy();
    header.value =
      header.value
        .split(';')
        .map((value) => value.trim())
        .filter((value) => !/^script-src(?:-elem|-attr)? /.test(value))
        .join('; ') +
      '; ' +
      scriptPolicy();
    fs.writeFileSync(path.join(root, 'vercel.json'), JSON.stringify(config, null, 2) + '\n');
  }
  verifyPolicy();
  console.log(
    'CSP hashes match all published HTML; arbitrary inline scripts and event attributes are blocked.',
  );
}
module.exports = { scriptPolicy, verifyPolicy };
