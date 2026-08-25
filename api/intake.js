'use strict';

// Vercel adapter for the shared, transactional public intake service.
// Database credentials and delivery destinations remain server-side only.
const { handlePublicIntake } = require('../server/public-intake');

module.exports = async (req, res) => {
  const result = await handlePublicIntake({ method: req.method, headers: req.headers, body: req.body });
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
};
