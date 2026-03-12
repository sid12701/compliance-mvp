// backend/src/middleware/authenticate.js
'use strict';

const jwt             = require('jsonwebtoken');
const { pool }        = require('../config/database');
const config          = require('../config/env');
const { AppError,
        ERROR_CODES } = require('../constants/errorCodes');

// ── JWT authentication middleware ─────────────────────────────────
// Applied to all protected routes.
// Verifies the token is valid, not blacklisted, and belongs to
// an active user. Attaches req.user on success.

async function authenticate(req, res, next) {
  try {
    // ── Step 1: Extract token from Authorization header ──────
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new AppError(
        'Authentication required. No Authorization header provided.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new AppError(
        'Authentication required. Authorization header must use Bearer scheme.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    const token = authHeader.substring(7); // Strip "Bearer " prefix

    if (!token) {
      throw new AppError(
        'Authentication required. Token is missing.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // ── Step 2: Verify JWT signature and expiry ───────────────
    // jwt.verify() throws JsonWebTokenError if signature is invalid
    // and TokenExpiredError if the exp claim has passed.
    // Both are caught by the global errorHandler.
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (jwtErr) {
      // Re-throw as AppError so errorHandler formats it correctly
      throw new AppError(
        jwtErr.name === 'TokenExpiredError'
          ? 'Authentication token has expired. Please log in again.'
          : 'Invalid authentication token.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // ── Step 3: Check token blacklist ─────────────────────────
    // The jti (JWT ID) claim is a UUID unique to this token.
    // On logout, the jti is inserted into token_blacklist.
    // If found here, this token was explicitly invalidated.
    if (!decoded.jti) {
      throw new AppError(
        'Invalid token format — missing jti claim.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    const blacklistResult = await pool.query(
      `SELECT 1 FROM token_blacklist WHERE jti = $1`,
      [decoded.jti]
    );

    if (blacklistResult.rows.length > 0) {
      throw new AppError(
        'Token has been invalidated. Please log in again.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // ── Step 4: Verify user exists and is active ──────────────
    // decoded.sub is the user's UUID set during login (auth.service.js)
    const userResult = await pool.query(
      `SELECT id, username, role, is_active
       FROM users
       WHERE id = $1`,
      [decoded.sub]
    );

    if (userResult.rows.length === 0) {
      throw new AppError(
        'User account not found.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      throw new AppError(
        'User account has been deactivated. Please contact your administrator.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // ── Step 5: Attach user to request ───────────────────────
    // Controllers and services access this as req.user
    req.user = {
      id:       user.id,
      username: user.username,
      role:     user.role,
    };

    // Also attach the raw JWT claims for use in logout
    // (need decoded.jti and decoded.exp to blacklist the token)
    req.jwtClaims = {
      jti: decoded.jti,
      exp: decoded.exp,
    };

    next();

  } catch (err) {
    next(err); // Pass to global errorHandler
  }
}

module.exports = { authenticate };