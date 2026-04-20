// backend/src/config/database.js
'use strict';

const { Pool } = require('pg');
const config   = require('./env');

// Keep PostgreSQL DATE columns as raw YYYY-MM-DD strings.
// If pg parses them into JS Date objects, JSON serialization converts them
// to UTC timestamps and the frontend can display the previous day.
require('pg').types.setTypeParser(1082, (value) => value);

// ── Create pool ───────────────────────────────────────────────────
// sslmode=require is enforced via the DATABASE_URL query parameter.
// The URL format is: postgresql://user:pass@host:5432/db?sslmode=require
// pg respects this automatically — no extra ssl config needed here.
const pool = new Pool({
  connectionString:        config.db.url,
  max:                     10,   // max simultaneous connections
  idleTimeoutMillis:       30000, // close idle connections after 30s
  connectionTimeoutMillis: 10000, // fail if can't connect within 10s
});

// ── Error handler ────────────────────────────────────────────────
// Prevents unhandled rejection crash if a pooled client errors
// unexpectedly (e.g. Supabase connection reset).
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool client error:', err.message);
});

// ── Health check helper ──────────────────────────────────────────
// Used at startup to confirm DB is reachable before accepting traffic.
async function testConnection() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('[DB] Connection pool established successfully.');
  } finally {
    // ALWAYS release the client back to the pool.
    // Forgetting this is a common bug that exhausts the pool.
    client.release();
  }
}

module.exports = { pool, testConnection };