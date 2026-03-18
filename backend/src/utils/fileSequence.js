'use strict';

const { pool }   = require('../config/database');
const { todayIST } = require('./istTime');

// ── Atomic daily sequence per file type ──────────────────────────
// Uses INSERT ... ON CONFLICT DO UPDATE to atomically increment.
// Resets automatically because the key includes the date —
// a new date = a new row starting at 1.
//
// fileType: 'search' | 'download' | 'upload'
// Returns: integer (1, 2, 3, ...)
//
// Can accept an optional pg client for use inside transactions.

async function getNextFileSequence(fileType, client) {
  const today = todayIST();
  const db    = client || pool;

  const result = await db.query(
    `INSERT INTO file_sequences (seq_date, file_type, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (seq_date, file_type)
     DO UPDATE SET last_seq = file_sequences.last_seq + 1
     RETURNING last_seq`,
    [today, fileType]
  );

  return result.rows[0].last_seq;
}

module.exports = { getNextFileSequence };