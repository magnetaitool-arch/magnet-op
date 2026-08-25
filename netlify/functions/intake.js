'use strict';

// Legacy Netlify adapter. It intentionally shares the exact same validation,
// tenant stamping, idempotency, rate limit, and durable outbox path as Vercel.
const { handlePublicIntake } = require('../../server/public-intake');

exports.handler = async (event) => {
  const result = await handlePublicIntake({
    method: event.httpMethod,
    headers: event.headers || {},
    body: event.body || '{}',
  });
  return { statusCode: result.status, headers: result.headers, body: JSON.stringify(result.body) };
};
