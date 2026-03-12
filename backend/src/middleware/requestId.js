// backend/src/middleware/requestId.js
'use strict';

const { randomUUID } = require('crypto');

// ── Attach request ID middleware ──────────────────────────────────
// Generates a UUID for every inbound request and attaches it to:
//   req.requestId    — used by all subsequent log lines in this request
//   res header       — returned to the client for end-to-end tracing
//
// If the client sends x-request-id we honour it (useful for
// tracing requests that originate from the frontend or monitoring tools).

function attachRequestId(req, res, next) {
  // Honour client-provided ID or generate a fresh one
  const requestId = req.headers['x-request-id'] || randomUUID();

  // Attach to request object — available everywhere downstream
  req.requestId = requestId;

  // Echo back in response headers so the client can correlate
  res.setHeader('x-request-id', requestId);

  next();
}

module.exports = { attachRequestId };