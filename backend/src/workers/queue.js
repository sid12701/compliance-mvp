'use strict';

const { Queue }             = require('bullmq');
const { createRedisClient } = require('../config/redis');

const QUEUE_NAMES = Object.freeze({
  SEARCH_GENERATION: 'search-generation',
  RESPONSE_ANALYSIS: 'response-analysis',
  BULK_DOWNLOAD:     'bulk-download',
  UPLOAD_GENERATION: 'upload-generation',
  STANDALONE_SEARCH: 'standalone-search',
});

const DEFAULT_JOB_OPTIONS = {
  attempts:         1,
  removeOnComplete: { count: 5 },   // ← was 100, keep only last 5
  removeOnFail:     { count: 5 },   // ← was 100, keep only last 5
};

const _queues = {};

function getQueue(name) {
  if (!_queues[name]) {
    _queues[name] = new Queue(name, {
      connection:        createRedisClient(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
      streams: {
        events: {
          maxLen: 50,    // ← limit event stream length, default is 10000
        },
      },
    });

    _queues[name].on('error', (err) => {
      console.error(`[Queue:${name}] Error:`, err.message);
    });
  }
  return _queues[name];
}

async function enqueueSearchGeneration({ batchId, targetDate, batchSequence, r2OutputKey, requestId }) {
  const queue = getQueue(QUEUE_NAMES.SEARCH_GENERATION);
  return queue.add(
    'generate-search',
    { batchId, targetDate, batchSequence, r2OutputKey, requestId },
    { ...DEFAULT_JOB_OPTIONS, jobId: `search-${batchId}` }
  );
}

async function enqueueResponseAnalysis({ batchId, targetDate, batchSequence, responseFileKey, requestId }) {
  const queue = getQueue(QUEUE_NAMES.RESPONSE_ANALYSIS);
  return queue.add(
    'analyse-response',
    { batchId, targetDate, batchSequence, responseFileKey, requestId },
    { ...DEFAULT_JOB_OPTIONS, jobId: `response-${batchId}` }
  );
}

async function enqueueBulkDownload({ batchId, targetDate, batchSequence, requestId }) {
  const queue = getQueue(QUEUE_NAMES.BULK_DOWNLOAD);
  return queue.add(
    'bulk-download',
    { batchId, targetDate, batchSequence, requestId },
    { ...DEFAULT_JOB_OPTIONS, jobId: `download-${batchId}` }
  );
}

async function enqueueUploadGeneration({ batchId, targetDate, batchSequence, requestId }) {
  const queue = getQueue(QUEUE_NAMES.UPLOAD_GENERATION);
  return queue.add(
    'generate-upload',
    { batchId, targetDate, batchSequence, requestId },
    { ...DEFAULT_JOB_OPTIONS, jobId: `upload-${batchId}` }
  );
}

async function enqueueStandaloneSearch({
  jobId,
  streamToken,
  targetDate,
  requestId,
  userId,
  ipAddress,
}) {
  const queue = getQueue(QUEUE_NAMES.STANDALONE_SEARCH);
  return queue.add(
    'standalone-search',
    { jobId, streamToken, targetDate, requestId, userId, ipAddress },
    { ...DEFAULT_JOB_OPTIONS, jobId }
  );
}

module.exports = {
  QUEUE_NAMES,
  getQueue,
  enqueueSearchGeneration,
  enqueueResponseAnalysis,
  enqueueBulkDownload,
  enqueueUploadGeneration,
  enqueueStandaloneSearch,
};
