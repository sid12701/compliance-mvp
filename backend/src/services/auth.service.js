// backend/src/services/auth.service.js
'use strict';

const bcrypt          = require('bcryptjs');
const jwt             = require('jsonwebtoken');
const { randomUUID }  = require('crypto');
const { pool }        = require('../config/database');
const config          = require('../config/env');
const { AppError,
        ERROR_CODES } = require('../constants/errorCodes');
const { AUDIT_ACTIONS } = require('../constants/auditActions');

// ── Dummy hash for timing consistency ────────────────────────────
// When a username is not found, we still run bcrypt.compare against
// this dummy hash. This ensures the response time is identical
// whether the username exists or not — prevents username enumeration
// via timing attacks.
const DUMMY_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewLj.4S/lJFyKW1C';

// ── Login ─────────────────────────────────────────────────────────
async function login({ username, password, ipAddress, requestId }) {

  // ── Step 1: Find user ────────────────────────────────────────
  const userResult = await pool.query(
    `SELECT id, username, password_hash, role, is_active
     FROM users
     WHERE username = $1`,
    [username]
  );

  const user       = userResult.rows[0] || null;
  const hashToTest = user ? user.password_hash : DUMMY_HASH;

  // ── Step 2: Verify password (always runs — timing consistency) ─
  const passwordMatch = await bcrypt.compare(password, hashToTest);

  // ── Step 3: Handle failure cases ────────────────────────────
  if (!user || !passwordMatch) {
    // Log the failed attempt — note user_id is NULL because login failed
    await _insertAuditLog({
      userId:    null,
      action:    AUDIT_ACTIONS.LOGIN_FAILED,
      batchId:   null,
      ipAddress,
      metadata:  {
        username_attempted: username,
        // Never log the password or hash
        reason: !user ? 'user_not_found' : 'invalid_password',
      },
    });

    // Same message for both cases — prevents username enumeration
    throw new AppError(
      'Invalid username or password.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  // ── Step 4: Check account is active ─────────────────────────
  if (!user.is_active) {
    throw new AppError(
      'User account has been deactivated. Please contact your administrator.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  // ── Step 5: Issue JWT ────────────────────────────────────────
  // jti (JWT ID) = UUID v4, unique per token.
  // Used as the blacklist key on logout.
  // sub (subject) = user UUID — identifies who this token belongs to.
  const jti   = randomUUID();
  const token = jwt.sign(
    {
      sub:  user.id,
      jti,
      role: user.role,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiry }
  );

  // ── Step 6: Update last_login_at ────────────────────────────
  // Fire-and-forget — failure here should not block the login response
  pool.query(
    `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
    [user.id]
  ).catch((err) => {
    console.error(`[Auth] Failed to update last_login_at for ${user.id}:`, err.message);
  });

  // ── Step 7: Write LOGIN audit entry ─────────────────────────
  await _insertAuditLog({
    userId:    user.id,
    action:    AUDIT_ACTIONS.LOGIN,
    batchId:   null,
    ipAddress,
    metadata:  { username: user.username },
  });

  return {
    token,
    user: {
      id:       user.id,
      username: user.username,
      role:     user.role,
    },
  };
}

// ── Logout ────────────────────────────────────────────────────────
async function logout({ userId, username, jti, expiresAt, ipAddress }) {

  // ── Step 1: Write LOGOUT audit entry ────────────────────────
  // Do this BEFORE blacklisting — if blacklist insert fails,
  // we still have an audit record that logout was attempted.
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.LOGOUT,
    batchId:   null,
    ipAddress,
    metadata:  {},
  });

  // ── Step 2: Blacklist the token ──────────────────────────────
  // Insert the jti into token_blacklist with the token's expiry.
  // The authenticate middleware checks this table on every request.
  // The cleanup job (post-MVP) deletes rows WHERE expires_at < NOW().
  await pool.query(
    `INSERT INTO token_blacklist (jti, expires_at)
     VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt]
  );
  // ON CONFLICT DO NOTHING — handles the edge case where a client
  // calls logout twice with the same token (double-click, retry).
}

// ── Internal audit log helper ─────────────────────────────────────
// Private to this service — Phase 6 replaces this with the shared
// audit.service.js. Defined here so auth works standalone in Phase 3.
async function _insertAuditLog({ userId, action, batchId, ipAddress, metadata }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, batch_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId    || null,
        action,
        batchId   || null,
        ipAddress || null,
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (auditErr) {
    // Audit log failure must never block the primary operation.
    // Log as ERROR for manual reconciliation but do not re-throw.
    console.error(
      `[Audit] INSERT failed for action "${action}":`,
      auditErr.message
    );
  }
}

// ── Create user helper (used by scripts/create-user.js) ──────────
// Not exposed via API — only called from the CLI seeding script.
async function createUser({ username, password, role = 'operator' }) {
  const BCRYPT_COST = 12; // PRD requirement: cost factor >= 12

  // Check username is not already taken
  const existing = await pool.query(
    `SELECT id FROM users WHERE username = $1`,
    [username]
  );
  if (existing.rows.length > 0) {
    throw new AppError(
      `Username "${username}" is already taken.`,
      409,
      ERROR_CODES.BATCH_ALREADY_EXISTS // reusing conflict code
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, username, role, created_at`,
    [username, passwordHash, role]
  );

  return result.rows[0];
}

module.exports = { login, logout, createUser };