'use strict';

const { publicRuntimeConfig } = require('../server/runtime-config');

// Deployment-owned public configuration only. Never return a service credential,
// even if accidentally assigned to SUPABASE_ANON_KEY. No fallback project.
/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    res.end();
    return;
  }
  const config = publicRuntimeConfig(process.env);
  res.statusCode = config ? 200 : 503;
  res.end(
    req.method === 'HEAD'
      ? undefined
      : `window.__MAGNET_RUNTIME_CONFIG__=${JSON.stringify(config)};`,
  );
};
