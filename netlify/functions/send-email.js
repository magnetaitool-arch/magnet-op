'use strict';

// Legacy Netlify compatibility route. It shares the JWT-authorized delivery
// outbox with Vercel and never calls a provider directly from browser input.
const { handleOutbox } = require('../../server/outbox');

exports.handler = async (event) => {
  let body = event.body || '{}';
  try { body = typeof body === 'string' ? JSON.parse(body || '{}') : body; }
  catch (error) { body = event.body; }
  if (body && typeof body === 'object') body = Object.assign({ action: 'enqueue-email' }, body);
  const result = await handleOutbox({
    method: event.httpMethod,
    headers: event.headers || {},
    body,
    query: event.queryStringParameters || {},
  });
  return { statusCode: result.status, headers: result.headers, body: JSON.stringify(result.body) };
};
