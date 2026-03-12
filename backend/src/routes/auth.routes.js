// backend/src/routes/auth.routes.js
'use strict';

const express                 = require('express');
const { loginRateLimiter }    = require('../middleware/rateLimiter');
const { authenticate }        = require('../middleware/authenticate');
const {
  handleLogin,
  handleLogout,
} = require('../controllers/auth.controller');

const router = express.Router();

// ── POST /api/v1/auth/login ───────────────────────────────────────
// Public endpoint — no JWT required.
// Rate limited: 5 requests per 15 minutes per IP.
// Body: { username: string, password: string }
router.post('/login', loginRateLimiter, handleLogin);

// ── POST /api/v1/auth/logout ──────────────────────────────────────
// Protected — requires valid Bearer JWT.
// Inserts the token's jti into token_blacklist.
router.post('/logout', authenticate, handleLogout);

module.exports = router;