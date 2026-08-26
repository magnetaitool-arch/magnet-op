'use strict';

const { handleSystemHealth } = require('../server/system-health');

module.exports = async (req, res) => {
  const result = await handleSystemHealth({ method: req.method, headers: req.headers, query: req.query || {} });
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
};
