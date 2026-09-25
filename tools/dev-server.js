'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_FILES, staticPath } = require('./static-files');
const root = path.resolve(__dirname, '..');
const types = /** @type {Record<string,string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
});

/** Safe, offline-first UI preview: does not proxy business APIs or load .env files. */
function createPreviewServer() {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const policy = config.headers
      .find((/** @type {{source:string}} */ group) => group.source === '/(.*)')
      .headers.find(
        (/** @type {{key:string}} */ header) => header.key === 'Content-Security-Policy',
      ).value;
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    // Preview is intentionally disconnected even if this shell inherited DB
    // credentials. Use a separately configured staging host for real auth tests.
    if (url.pathname === '/api/runtime-config') {
      res.writeHead(503, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : 'window.__MAGNET_RUNTIME_CONFIG__=null;');
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'LOCAL_API_UNAVAILABLE' }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const file = staticPath(url.pathname);
    if (!file || !STATIC_FILES.includes(file)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const target = path.join(root, file);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular file');
      let start = 0,
        end = stat.size - 1;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (
          !range ||
          Number(range[1]) >= stat.size ||
          (range[2] && Number(range[2]) < Number(range[1]))
        ) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), end) : end;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Accept-Ranges', 'bytes');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(target, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 48763);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  createPreviewServer().listen(port, '127.0.0.1', () =>
    console.log(`Magnet OS preview: http://127.0.0.1:${port} (business APIs disabled)`),
  );
}
module.exports = { createPreviewServer };
