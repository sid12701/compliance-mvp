'use strict';

const config = require('../config/env');
const { startWorkers, shutdownWorkers } = require('./index');
const { QUEUE_NAMES, getQueue } = require('./queue');

const CHECK_INTERVAL_MS = parseInt(process.env.WORKERS_CHECK_INTERVAL_MS || '10000', 10);
const IDLE_EXIT_MS      = parseInt(process.env.WORKERS_IDLE_EXIT_MS || '120000', 10);

let lastBusyAt = Date.now();

function _getQueues() {
  return Object.values(QUEUE_NAMES).map((name) => getQueue(name));
}

async function _isIdle() {
  const queues = _getQueues();
  const results = await Promise.all(
    queues.map((q) => q.getJobCounts('wait', 'active', 'delayed', 'paused'))
  );

  const anyBusy = results.some((c) =>
    (c.wait || 0) > 0 ||
    (c.active || 0) > 0 ||
    (c.delayed || 0) > 0
  );

  return !anyBusy;
}

async function _watchIdle() {
  const idle = await _isIdle();
  if (!idle) {
    lastBusyAt = Date.now();
    return;
  }

  if (Date.now() - lastBusyAt >= IDLE_EXIT_MS) {
    await shutdownWorkers();
    process.exit(0);
  }
}

async function run() {
  if (!config.workers.enabled) {
    console.error('Workers are disabled. Set WORKERS_ENABLED=true.');
    process.exit(1);
  }

  startWorkers();

  const timer = setInterval(() => {
    _watchIdle().catch((err) => {
      console.error('[Workers] Idle watcher error:', err.message);
    });
  }, CHECK_INTERVAL_MS);

  if (typeof timer.unref === 'function') timer.unref();

  process.on('SIGTERM', async () => {
    clearInterval(timer);
    await shutdownWorkers();
    process.exit(0);
  });
}

run().catch((err) => {
  console.error('[Workers] Startup failed:', err.message);
  process.exit(1);
});
