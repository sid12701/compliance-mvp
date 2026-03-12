// backend/src/middleware/rateLimiter.js
'use strict';

const rateLimit       = require('express-rate-limit');
const { ERROR_CODES } = require('../constants/errorCodes');

// ── Login rate limiter ────────────────────────────────────────────
// Applied only to POST /api/v1/auth/login.
// Allows 5 requests per 15 minutes per IP address.
// Returns HTTP 429 with standard error envelope when exceeded.
//
// NOTE: Uses in-memory store (default).
// If Render ever scales to multiple instances, switch to:
//   store: new RedisStore({ client: redisClient })
// from the 'rate-limit-redis' package.

const loginRateLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes in milliseconds
  max:              5,               // max requests per window per IP
  standardHeaders:  true,            // adds RateLimit-* headers to response
  legacyHeaders:    false,           // disables deprecated X-RateLimit-* headers

  // Key generator — rate limit by IP address
  // req.ip works correctly on Render because Render sets the
  // X-Forwarded-For header and Express trusts it.
  keyGenerator: (req) => req.ip,

  // Override default response to use our standard error envelope
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code:    ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Too many login attempts. Please wait 15 minutes before trying again.',
        details: {
          retryAfter: '15 minutes',
        },
      },
    });
  },

  // Skip rate limiting in test environment
  skip: () => process.env.NODE_ENV === 'test',
});

module.exports = { loginRateLimiter };
