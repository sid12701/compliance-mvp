// backend/src/services/auth.service.js
'use strict';

const bcrypt              = require('bcryptjs');
const jwt                 = require('jsonwebtoken');
const { randomUUID }      = require('crypto');
const { pool }            = require('../config/database');
const config              = require('../config/env');
const { AppError,
        ERROR_CODES }     = require('../constants/errorCodes');
const { AUDIT_ACTIONS }   = require('../constants/auditActions');
const { insertAuditLog }  = require('./audit.service');

const DUMMY_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewLj.4S/lJFyKW1C';

async function login({ username, password, ipAddress, requestId }) {

  const userResult = await pool.query(
    `SELECT id, username, password_hash, role, is_active
     FROM users WHERE username = $1`,
    [username]
  );

  const user       = userResult.rows[0] || null;
  const hashToTest = user ? user.password_hash : DUMMY_HASH;

  const passwordMatch = await bcrypt.compare(password, hashToTest);

  if (!user || !passwordMatch) {
    await insertAuditLog({
      userId:    null,
      action:    AUDIT_ACTIONS.LOGIN_FAILED,
      batchId:   null,
      ipAddress,
      metadata:  {
        username_attempted: username,
        reason: !user ? 'user_not_found' : 'invalid_password',
      },
    });

    throw new AppError(
      'Invalid username or password.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  if (!user.is_active) {
    throw new AppError(
      'User account has been deactivated. Please contact your administrator.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  const jti   = randomUUID();
  const token = jwt.sign(
    { sub: user.id, jti, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiry }
  );

  pool.query(
    `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
    [user.id]
  ).catch((err) => {
    console.error(`[Auth] Failed to update last_login_at for ${user.id}:`, err.message);
  });

  await insertAuditLog({
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

async function logout({ userId, username, jti, expiresAt, ipAddress }) {

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.LOGOUT,
    batchId:   null,
    ipAddress,
    metadata:  {},
  });

  await pool.query(
    `INSERT INTO token_blacklist (jti, expires_at)
     VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt]
  );
}

async function createUser({ username, password, role = 'operator' }) {
  const BCRYPT_COST = 12;

  const existing = await pool.query(
    `SELECT id FROM users WHERE username = $1`,
    [username]
  );
  if (existing.rows.length > 0) {
    throw new AppError(
      `Username "${username}" is already taken.`,
      409,
      ERROR_CODES.CONFLICT
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