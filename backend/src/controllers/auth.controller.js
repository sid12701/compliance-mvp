// backend/src/controllers/auth.controller.js
'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const authService               = require('../services/auth.service');

// ── POST /api/v1/auth/login ───────────────────────────────────────
async function handleLogin(req, res, next) {
  try {
    // ── Validate request shape ────────────────────────────────
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || !username.trim()) {
      throw new AppError(
        'Request body is missing required field: username.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    if (!password || typeof password !== 'string') {
      throw new AppError(
        'Request body is missing required field: password.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    // ── Call service ──────────────────────────────────────────
    const result = await authService.login({
      username:  username.trim(),
      password,
      ipAddress: req.ip,
      requestId: req.requestId,
    });

    // ── Send response ─────────────────────────────────────────
    res.status(200).json({
      success: true,
      data: {
        token:      result.token,
        expires_in: '8h',
        user: {
          id:       result.user.id,
          username: result.user.username,
          role:     result.user.role,
        },
      },
    });

  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/auth/logout ──────────────────────────────────────
async function handleLogout(req, res, next) {
  try {
    // req.user and req.jwtClaims are attached by authenticate middleware
    // No additional request body needed for logout

    await authService.logout({
      userId:    req.user.id,
      username:  req.user.username,
      jti:       req.jwtClaims.jti,
      expiresAt: new Date(req.jwtClaims.exp * 1000), // exp is Unix seconds
      ipAddress: req.ip,
      requestId: req.requestId,
    });

    res.status(200).json({
      success: true,
      data: {
        message: 'Logged out successfully.',
      },
    });

  } catch (err) {
    next(err);
  }
}

module.exports = { handleLogin, handleLogout };
