'use strict';

// Public, deployment-scoped browser configuration. SUPABASE_ANON_KEY is a
// publishable browser key by design; service-role/server secrets are never read
// or returned here. Preview and Development are configured in Vercel to use the
// separate Staging project, while Production retains its current defaults.
module.exports = function handler(req, res) {
  const isProduction = process.env.VERCEL_ENV === 'production';
  const fallbackUrl = isProduction ? 'https://jdylrthffifbhyrrhuqd.supabase.co' : '';
  const fallbackKey = isProduction ? 'sb_publishable_6Qe2KdPIZ13Ij2wvkS12rA_k2ytZQLz' : '';
  const url = String(process.env.SUPABASE_URL || fallbackUrl).trim();
  const key = String(process.env.SUPABASE_ANON_KEY || fallbackKey).trim();
  const validUrl = /^https:\/\/[a-z]{20}\.supabase\.co\/?$/.test(url);
  const validKey = key.startsWith('sb_publishable_') || key.startsWith('eyJ');
  const config = validUrl && validKey ? { url: url.replace(/\/$/, ''), key } : null;

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = config ? 200 : 503;
  res.end(`window.__MAGNET_RUNTIME_CONFIG__=${JSON.stringify(config)};`);
};
