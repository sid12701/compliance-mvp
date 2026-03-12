// backend/src/constants/errorCodes.js
'use strict';

// ── All API error codes ───────────────────────────────────────────
// These are the stable, frontend-safe code strings.
// The frontend can switch on these values — they never change
// between deploys even if the message text changes.
const ERROR_CODES = Object.freeze({

  // 400 — Bad input
  INVALID_REQUEST:              'INVALID_REQUEST',

  // 401 — Auth failures
  UNAUTHORIZED:                 'UNAUTHORIZED',

  // 403 — Valid auth, wrong permissions
  FORBIDDEN:                    'FORBIDDEN',

  // 404 — Resource not found
  BATCH_NOT_FOUND:              'BATCH_NOT_FOUND',

  // 409 — Conflict / state problems
  BATCH_ALREADY_EXISTS:         'BATCH_ALREADY_EXISTS',
  INVALID_STATE_TRANSITION:     'INVALID_STATE_TRANSITION',

  // 410 — Gone (retention purge)
  BATCH_PURGED:                 'BATCH_PURGED',

  // 413 — File too large
  FILE_TOO_LARGE:               'FILE_TOO_LARGE',

  // 422 — Validation failure
  INVALID_FILENAME:             'INVALID_FILENAME',

  // 429 — Rate limited
  RATE_LIMIT_EXCEEDED:          'RATE_LIMIT_EXCEEDED',

  // 500 — Internal errors
  INTERNAL_ERROR:               'INTERNAL_ERROR',

  // 503 — Dependency unavailable
  SERVICE_UNAVAILABLE:          'SERVICE_UNAVAILABLE',
});

// ── HTTP status code map ──────────────────────────────────────────
// Maps each error code to its correct HTTP status number.
// Used by the global error handler to set res.status().
const HTTP_STATUS = Object.freeze({
  [ERROR_CODES.INVALID_REQUEST]:          400,
  [ERROR_CODES.UNAUTHORIZED]:             401,
  [ERROR_CODES.FORBIDDEN]:               403,
  [ERROR_CODES.BATCH_NOT_FOUND]:         404,
  [ERROR_CODES.BATCH_ALREADY_EXISTS]:    409,
  [ERROR_CODES.INVALID_STATE_TRANSITION]: 409,
  [ERROR_CODES.BATCH_PURGED]:            410,
  [ERROR_CODES.FILE_TOO_LARGE]:          413,
  [ERROR_CODES.INVALID_FILENAME]:        422,
  [ERROR_CODES.RATE_LIMIT_EXCEEDED]:     429,
  [ERROR_CODES.INTERNAL_ERROR]:          500,
  [ERROR_CODES.SERVICE_UNAVAILABLE]:     503,
});

// ── AppError class ────────────────────────────────────────────────
// Custom error class that carries an error code and HTTP status.
// Thrown by service and utility functions.
// Caught and formatted by the global errorHandler middleware.
//
// Usage:
//   throw new AppError('Batch not found.', 404, ERROR_CODES.BATCH_NOT_FOUND)
//   throw new AppError('Invalid filename.', 422, ERROR_CODES.INVALID_FILENAME, {
//     failed_check: 'sequence_mismatch',
//     expected: '00016',
//     received: '00015',
//   })
class AppError extends Error {
  constructor(message, statusCode, code, details = {}) {
    super(message);
    this.name       = 'AppError';
    this.statusCode = statusCode;
    this.code       = code;
    this.details    = details;
  }
}

module.exports = { ERROR_CODES, HTTP_STATUS, AppError };