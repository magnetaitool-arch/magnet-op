'use strict';
const { handleWebhook } = require('../server/resend-webhook');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; res.end('{"error":"method_not_allowed"}'); return; }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) { res.statusCode = 413; res.end('{"error":"payload_too_large"}'); return; }
      chunks.push(Buffer.from(chunk));
    }
    const result = await handleWebhook(Buffer.concat(chunks), req.headers);
    res.statusCode = result.status; res.end(JSON.stringify(result.body));
  } catch { res.statusCode = 400; res.end('{"error":"invalid_body"}'); }
};
module.exports.config = { api: { bodyParser: false } };
