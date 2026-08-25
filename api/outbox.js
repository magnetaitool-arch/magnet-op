'use strict';

const { handleOutbox } = require('../server/outbox');

module.exports = async (req, res) => {
  const result = await handleOutbox({ method: req.method, headers: req.headers, body: req.body, query: req.query || {} });
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
};
