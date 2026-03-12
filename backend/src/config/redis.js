// backend/src/config/redis.js
'use strict';

const Redis  = require('ioredis');
const config = require('./env');

// ── BullMQ connection factory ─────────────────────────────────────
// BullMQ requires a NEW connection per Queue and per Worker.
// lazyConnect must be FALSE for workers — they use blocking commands
// (BLMOVE) and must connect immediately to start polling for jobs.
function createRedisClient() {
  const client = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,  // Required by BullMQ — do not change
    enableReadyCheck:     false,
    lazyConnect:          false, // MUST be false for BullMQ workers
  });

  client.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
  });

  client.on('connect', () => {
    console.log('[Redis] Connected');
  });

  return client;
}

// ── Shared client for non-BullMQ use ─────────────────────────────
const redisClient = createRedisClient();

module.exports = { createRedisClient, redisClient };