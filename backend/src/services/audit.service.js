// backend/src/services/audit.service.js
'use strict';

const { pool }              = require('../config/database');
const { sanitizeObject }    = require('../utils/panSanitizer');
const { AUDIT_ACTIONS }     = require('../constants/auditActions');

// ── Insert one audit log entry ────────────────────────────────────
// Called from route handlers (user actions) and BullMQ workers (system actions).
//
// Parameters:
//   userId    — UUID of the acting user. NULL for system/CRON actions.
//   action    — one of AUDIT_ACTIONS constants. CHECK-constrained in DB.
//   batchId   — UUID of the affected batch. NULL for auth events.
//   ipAddress — client IP from req.ip. NULL for worker actions.
//   metadata  — plain JS object. PAN-sanitized before insert.
//   client    — optional pg client for writing inside a transaction.
//
// Returns: void
// Never throws — audit failure must never block the primary operation.

async function insertAuditLog({
  userId    = null,
  action,
  batchId   = null,
  ipAddress = null,
  metadata  = {},
}, client) {
  try {
    // Validate action is a known constant
    const validActions = Object.values(AUDIT_ACTIONS);
    if (!validActions.includes(action)) {
      console.error(`[Audit] Unknown action "${action}" — skipping insert`);
      return;
    }

    // Sanitize all string values in metadata
    // Catches any PAN that accidentally ended up in an error message or field value
    const sanitizedMetadata = sanitizeObject(metadata || {});

    await (client || pool).query(
      `INSERT INTO audit_log (user_id, action, batch_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId    || null,
        action,
        batchId   || null,
        ipAddress || null,
        JSON.stringify(sanitizedMetadata),
      ]
    );

  } catch (err) {
    // Log as ERROR for manual reconciliation but never re-throw.
    // The calling operation must continue regardless of audit failures.
    console.error(JSON.stringify({
      level:     'ERROR',
      timestamp: new Date().toISOString(),
      message:   `Audit INSERT failed for action "${action}"`,
      error:     err.message,
      userId,
      batchId,
    }));
  }
}

// ── Query helpers ─────────────────────────────────────────────────
// Used by the frontend dashboard to show activity timelines.

// Get full audit trail for a specific batch
async function getAuditLogForBatch(batchId) {
  const result = await pool.query(
    `SELECT
       al.id, al.action, al.ip_address, al.metadata, al.created_at,
       u.username
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.batch_id = $1
     ORDER BY al.created_at ASC`,
    [batchId]
  );
  return result.rows;
}

// Get recent activity across all batches (for dashboard feed)
async function getRecentActivity(limit = 50) {
  const result = await pool.query(
    `SELECT
       al.id, al.action, al.batch_id, al.ip_address,
       al.metadata, al.created_at,
       u.username,
       cb.target_date, cb.batch_sequence
     FROM audit_log al
     LEFT JOIN users u  ON u.id  = al.user_id
     LEFT JOIN ckyc_batches cb ON cb.id = al.batch_id
     ORDER BY al.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// List standalone search runs (used on standalone search page)
async function listStandaloneSearches(limit = 20) {
  const safeLimit = Math.min(parseInt(limit, 10) || 20, 100);
  const result = await pool.query(
    `SELECT
       al.id, al.metadata, al.created_at,
       u.username
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.action = $1
       AND (al.metadata->>'standalone') = 'true'
     ORDER BY al.created_at DESC
     LIMIT $2`,
    [AUDIT_ACTIONS.SEARCH_FILE_DOWNLOADED, safeLimit]
  );
  return result.rows;
}

module.exports = {
  insertAuditLog,
  getAuditLogForBatch,
  getRecentActivity,
  listStandaloneSearches,
};
