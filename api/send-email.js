'use strict';

// Compatibility route for existing MAGNET OS clients. Delivery now goes through
// the JWT-authorized durable outbox; the browser never calls Resend directly.
const { handleOutbox } = require('../server/outbox');

module.exports = async (req, res) => {
  const body = req.body && typeof req.body === 'object'
    ? Object.assign({ action: 'enqueue-email' }, req.body)
    : req.body;
  const result = await handleOutbox({ method: req.method, headers: req.headers, body, query: req.query || {} });
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
};
