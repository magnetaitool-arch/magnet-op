'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { STATIC_FILES, SERVER_FILES } = require('./static-files');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.magnet-build');

function build() {
  require('./csp').verifyPolicy();
  require('./asset-versions').verifyAssetVersions();
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (config.installCommand === '' && Object.keys(pkg.dependencies || {}).length)
    throw new Error('Production dependencies require an explicit deployment install strategy');

  const files = [...STATIC_FILES, ...SERVER_FILES, 'vercel.json'];
  // Validate every input before replacing the previous generated artifact.
  const inputs = files.map((file) => {
    const target = path.join(root, file),
      stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid release file: ${file}`);
    const bytes = fs.readFileSync(target);
    if (file.endsWith('.js')) new vm.Script(bytes.toString(), { filename: file });
    if (file.endsWith('.json')) JSON.parse(bytes.toString());
    if (file === 'index.html') {
      const html = bytes.toString();
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (!/\bsrc\s*=/.test(match[1]) && match[2].trim())
          new vm.Script(match[2], { filename: 'index.html inline script' });
      }
      for (const match of html.matchAll(
        /(?:src|href)="(\/(?:modules|styles)\/[^"?]+)(?:\?[^" ]*)?"/g,
      )) {
        if (!STATIC_FILES.includes(match[1].slice(1)))
          throw new Error(`Unpackaged asset: ${match[1]}`);
      }
    }
    return { file, bytes };
  });
  // Only this generated directory is ever removed. No configurable delete target.
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())
    throw new Error('Build output must not be a symlink');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output);
  const manifest = inputs.map(({ file, bytes }) => {
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return {
      path: file,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
  fs.writeFileSync(
    path.join(output, 'artifact-manifest.json'),
    JSON.stringify({ format: 1, files: manifest }, null, 2) + '\n',
  );
  console.log(
    `Built ${manifest.length} allowlisted static/server files in .magnet-build (no deployment).`,
  );
  return manifest;
}
if (require.main === module) build();
module.exports = { build };
