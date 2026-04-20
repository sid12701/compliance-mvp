'use strict';

const { pool } = require('../config/database');

async function appendBatchTimeline({
  batchId,
  type,
  user = null,
  metadata = {},
}, client) {
  if (!batchId || !type) return;

  const event = {
    type,
    at: new Date().toISOString(),
    user_id: user?.id || null,
    username: user?.username || null,
    metadata: metadata || {},
  };

  await (client || pool).query(
    `UPDATE ckyc_batches
     SET timeline = COALESCE(timeline, '[]'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [batchId, JSON.stringify([event])]
  );
}

module.exports = {
  appendBatchTimeline,
};
