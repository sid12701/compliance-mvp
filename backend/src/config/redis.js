// backend/src/config/redis.js
'use strict';

const Redis  = require('ioredis');
const config = require('./env');

// ── Redis client factory ──────────────────────────────────────────
// BullMQ requires a NEW connection per Queue and per Worker.
// This factory is called each time a new connection is needed.
// Never share a single ioredis instance across multiple BullMQ objects.
function createRedisClient() {
  const client = new Redis(config.redis.url, {
    maxRetriesPerRequest: null, // Required by BullMQ — do not change
    enableReadyCheck:     false,
    lazyConnect:          true,
  });

  client.on('error', (err) => {
    // Log but do not crash — BullMQ handles reconnection internally
    console.error('[Redis] Connection error:', err.message);
  });

  client.on('connect', () => {
    console.log('[Redis] Connected');
  });

  return client;
}

// ── Shared client for non-BullMQ use ─────────────────────────────
// Used by the token blacklist cleanup job (post-MVP).
// NOT used by BullMQ queues or workers.
const redisClient = createRedisClient();

module.exports = { createRedisClient, redisClient };