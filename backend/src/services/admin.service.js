'use strict';

const bcrypt        = require('bcryptjs');
const { pool }      = require('../config/database');
const { AppError, ERROR_CODES } = require('../constants/errorCodes');

async function listUsers() {
  const result = await pool.query(
    `SELECT id, username, role, is_active, last_login_at, created_at, updated_at
     FROM users
     ORDER BY created_at ASC`
  );
  return result.rows;
}

async function createUser({ username, password, role, createdBy }) {
  const existing = await pool.query(
    `SELECT id FROM users WHERE username = $1`, [username]
  );

  if (existing.rows.length > 0) {
    throw new AppError(
      `Username "${username}" is already taken.`,
      409,
      ERROR_CODES.CONFLICT
    );
  }

  const validRoles = ['operator', 'dev'];
  if (!validRoles.includes(role)) {
    throw new AppError(
      `Invalid role "${role}". Must be one of: ${validRoles.join(', ')}.`,
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const hash   = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3)
     RETURNING id, username, role, is_active, created_at`,
    [username, hash, role]
  );

  return result.rows[0];
}

async function updateUser({ userId, password, role, is_active, updatedBy }) {
  const existing = await pool.query(
    `SELECT id FROM users WHERE id = $1`, [userId]
  );

  if (existing.rows.length === 0) {
    throw new AppError('User not found.', 404, ERROR_CODES.NOT_FOUND);
  }

  const updates = [];
  const values  = [];
  let   idx     = 1;

  if (password !== undefined) {
    const hash = await bcrypt.hash(password, 12);
    updates.push(`password_hash = $${idx++}`);
    values.push(hash);
  }

  if (role !== undefined) {
    const validRoles = ['operator', 'dev'];
    if (!validRoles.includes(role)) {
      throw new AppError(
        `Invalid role "${role}".`,
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }
    updates.push(`role = $${idx++}`);
    values.push(role);
  }

  if (is_active !== undefined) {
    updates.push(`is_active = $${idx++}`);
    values.push(is_active);
  }

  values.push(userId);

  const result = await pool.query(
    `UPDATE users
     SET ${updates.join(', ')}
     WHERE id = $${idx}
     RETURNING id, username, role, is_active, updated_at`,
    values
  );

  return result.rows[0];
}

async function listAuditLogs({
  page = 1, limit = 50,
  userId, action, batchId,
  startDate, endDate,
}) {
  const safeLimit = Math.min(parseInt(limit, 10) || 50, 200);
  const safePage  = Math.max(parseInt(page,  10) || 1,  1);
  const offset    = (safePage - 1) * safeLimit;

  const conditions = ['1=1'];
  const params     = [];
  let   idx        = 1;

  if (userId) {
    conditions.push(`al.user_id = $${idx++}`);
    params.push(userId);
  }
  if (action) {
    conditions.push(`al.action = $${idx++}`);
    params.push(action);
  }
  if (batchId) {
    conditions.push(`al.batch_id = $${idx++}`);
    params.push(batchId);
  }
  if (startDate) {
    conditions.push(`al.created_at >= $${idx++}::timestamptz`);
    params.push(startDate);
  }
  if (endDate) {
    conditions.push(`al.created_at <= $${idx++}::timestamptz`);
    params.push(endDate + 'T23:59:59Z');
  }

  const where = conditions.join(' AND ');

  const [logsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT
         al.id, al.action, al.batch_id, al.ip_address,
         al.metadata, al.created_at,
         u.username
       FROM audit_log al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE ${where}
       ORDER BY al.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, safeLimit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM audit_log al
       WHERE ${where}`,
      params
    ),
  ]);

  const total      = parseInt(countResult.rows[0].total, 10);
  const totalPages = Math.ceil(total / safeLimit);

  return {
    logs: logsResult.rows,
    pagination: {
      page:        safePage,
      limit:       safeLimit,
      total_count: total,
      total_pages: totalPages,
    },
  };
}

module.exports = { listUsers, createUser, updateUser, listAuditLogs };