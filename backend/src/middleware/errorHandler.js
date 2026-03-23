// backend/src/middleware/errorHandler.js
'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const { sanitizePAN }           = require('../utils/panSanitizer');

// ── Global error handler ──────────────────────────────────────────
// MUST be the last app.use() call in index.js.
// MUST have exactly 4 parameters — Express requires this signature
// to recognise it as an error handler.
//
// Formats every error into the standard envelope:
// {
//   "success": false,
//   "error": {
//     "code":    "SCREAMING_SNAKE_CASE",
//     "message": "Human-readable string.",
//     "details": {}
//   }
// }

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {

  // ── Log the error ────────────────────────────────────────────
  // Always log with requestId so the error is traceable.
  // Sanitise the message before logging in case it contains PAN data.
  const sanitizedMessage = sanitizePAN(err.message || 'Unknown error');

  const logEntry = {
    level:      err instanceof AppError && err.statusCode < 500 ? 'WARN' : 'ERROR',
    timestamp:  new Date().toISOString(),
    requestId:  req.requestId,
    errorType:  err.name || 'Error',
    errorCode:  err.code  || ERROR_CODES.INTERNAL_ERROR,
    message:    sanitizedMessage,
    path:       req.path,
    method:     req.method,
  };

  // Only include stack trace in non-production environments
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    logEntry.stack = sanitizePAN(err.stack);
  }

  if (logEntry.level === 'ERROR') {
    console.error(JSON.stringify(logEntry));
  } else {
    console.warn(JSON.stringify(logEntry));
  }

  // ── AppError — intentional, known errors ─────────────────────
  // Thrown by our services and utilities with a specific code and status.
  // Return exactly what we set — the message is safe for the client.
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code:    err.code,
        message: err.message,
        details: err.details || {},
      },
    });
  }

  // ── JWT errors (from jsonwebtoken library) ────────────────────
  // These are thrown by jwt.verify() in the authenticate middleware.
  // Map them to structured 401 responses.
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: {
        code:    ERROR_CODES.UNAUTHORIZED,
        message: 'Invalid authentication token.',
        details: {},
      },
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: {
        code:    ERROR_CODES.UNAUTHORIZED,
        message: 'Authentication token has expired. Please log in again.',
        details: {},
      },
    });
  }

  // ── express-rate-limit errors ─────────────────────────────────
  if (err.statusCode === 429 || err.status === 429) {
    return res.status(429).json({
      success: false,
      error: {
        code:    ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Too many requests. Please wait before retrying.',
        details: {},
      },
    });
  }

  // ── Generic unhandled error ───────────────────────────────────
  // Unknown crash — database failure, null pointer, etc.
  // NEVER return the raw error message — it may contain PAN data,
  // SQL queries, or internal paths.
  return res.status(500).json({
    success: false,
    error: {
      code:    ERROR_CODES.INTERNAL_ERROR,
      message: 'An internal error occurred. The operations team has been notified.',
      details: {},
    },
  });
}

module.exports = { errorHandler };