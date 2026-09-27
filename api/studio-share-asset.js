'use strict';
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('{"error":"method_not_allowed"}');
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!/^[a-f0-9]{64}$/.test(body?.token || '') || !/^[-a-f0-9]{36}$/.test(body?.fileId || ''))
      throw Error('invalid');
    const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''),
      key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(base) || !key) throw Error('configuration');
    const headers = {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    };
    const info = await fetch(base + '/rest/v1/rpc/studio_shared_asset_v3', {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_token: body.token, p_file_id: body.fileId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!info.ok) throw Error('denied');
    const file = await info.json();
    const path = [file.bucket, ...file.path.split('/')].map(encodeURIComponent).join('/');
    const signed = await fetch(base + '/storage/v1/object/sign/' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expiresIn: file.expiresIn }),
      signal: AbortSignal.timeout(10000),
    });
    if (!signed.ok) throw Error('denied');
    const result = await signed.json();
    const url = result.signedURL || result.signedUrl;
    if (!url) throw Error('denied');
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        url: new URL(url.startsWith('/object/') ? '/storage/v1' + url : url, base).href,
      }),
    );
  } catch {
    res.statusCode = 403;
    res.end('{"error":"share_asset_unavailable"}');
  }
};
