'use strict';

const { Queue }            = require('bullmq');
const { createRedisClient } = require('../config/redis');

// ── Queue name constants ──────────────────────────────────────────
// Used both here (queue definitions) and in worker files (Phase 5).
// Centralised so a typo in one place doesn't create a phantom queue.
const QUEUE_NAMES = Object.freeze({
  SEARCH_GENERATION:  'search-generation',
  RESPONSE_ANALYSIS:  'response-analysis',
  BULK_DOWNLOAD:      'bulk-download',
  UPLOAD_GENERATION:  'upload-generation',
});

// ── Default job options ───────────────────────────────────────────
// attempts: 1 = no automatic retries (PRD requirement).
// removeOnComplete/Fail: keeps last 100 jobs for debugging visibility
// without letting the Redis queue grow unboundedly.
const DEFAULT_JOB_OPTIONS = {
  attempts:          1,
  removeOnComplete:  { count: 100 },
  removeOnFail:      { count: 100 },
};

// ── Queue instances ───────────────────────────────────────────────
// Created lazily — only instantiated when first used.
// This prevents Redis connection errors from crashing the app
// at startup if Redis isn't yet configured (e.g. during Phase 3/4 testing).
const _queues = {};

function getQueue(name) {
  if (!_queues[name]) {
    _queues[name] = new Queue(name, {
      connection:        createRedisClient(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    _queues[name].on('error', (err) => {
      console.error(`[Queue:${name}] Error:`, err.message);
    });
  }
  return _queues[name];
}

// ── Enqueue helpers ───────────────────────────────────────────────
// Each function is specific to one job type with typed payloads.
// Controllers and services call these — never getQueue() directly.

// Triggered by: CRON webhook + manual generate endpoint
// Processed by: searchGenWorker (Phase 5)
async function enqueueSearchGeneration({ batchId, targetDate, batchSequence, r2OutputKey, requestId }) {
  const queue = getQueue(QUEUE_NAMES.SEARCH_GENERATION);
  return queue.add(
    'generate-search',
    { batchId, targetDate, batchSequence, r2OutputKey, requestId },
    {
      ...DEFAULT_JOB_OPTIONS,
      // Deduplicate: if this batchId is already queued, ignore the duplicate
      jobId: `search-${batchId}`,
    }
  );
}

// Triggered by: process-response endpoint
// Processed by: responseAnalysisWorker (Phase 5)
// After completion, the worker enqueues bulk-download + upload-generation
async function enqueueResponseAnalysis({ batchId, targetDate, batchSequence, responseFileKey, requestId }) {
  const queue = getQueue(QUEUE_NAMES.RESPONSE_ANALYSIS);
  return queue.add(
    'analyse-response',
    { batchId, targetDate, batchSequence, responseFileKey, requestId },
    {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `response-${batchId}`,
    }
  );
}

// Triggered by: responseAnalysisWorker after parsing download_list
// Processed by: bulkDownloadWorker (Phase 5)
async function enqueueBulkDownload({ batchId, targetDate, batchSequence, requestId }) {
  const queue = getQueue(QUEUE_NAMES.BULK_DOWNLOAD);
  return queue.add(
    'bulk-download',
    // No PAN data in the payload — worker reads response_analysis_result
    // from the DB using batchId
    { batchId, targetDate, batchSequence, requestId },
    {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `download-${batchId}`,
    }
  );
}

// Triggered by: responseAnalysisWorker after parsing upload_list
// Processed by: uploadGenWorker (Phase 5)
async function enqueueUploadGeneration({ batchId, targetDate, batchSequence, requestId }) {
  const queue = getQueue(QUEUE_NAMES.UPLOAD_GENERATION);
  return queue.add(
    'generate-upload',
    // No PAN data in the payload — worker reads response_analysis_result
    // from the DB using batchId
    { batchId, targetDate, batchSequence, requestId },
    {
      ...DEFAULT_JOB_OPTIONS,
      jobId: `upload-${batchId}`,
    }
  );
}

module.exports = {
  QUEUE_NAMES,
  getQueue,
  enqueueSearchGeneration,
  enqueueResponseAnalysis,
  enqueueBulkDownload,
  enqueueUploadGeneration,
};