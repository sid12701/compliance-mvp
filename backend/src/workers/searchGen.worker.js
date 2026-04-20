'use strict';

const { Worker } = require('bullmq');
const { pool } = require('../config/database');
const { createRedisClient } = require('../config/redis');
const { QUEUE_NAMES } = require('./queue');
const { runPythonScript } = require('../utils/ipcRunner');
const { sanitizePAN } = require('../utils/panSanitizer');
const { sendGeneratedAlert, sendFailedAlert } = require('../services/email.service');
const { appendBatchTimeline } = require('../services/timeline.service');

function createSearchGenWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SEARCH_GENERATION,
    async (job) => {
      const { batchId, targetDate, batchSequence, r2OutputKey, requestId } = job.data;

      try {
        if (!batchSequence) {
          throw new Error('Missing batchSequence for search generation job.');
        }
        if (!r2OutputKey) {
          throw new Error('Missing r2OutputKey for search generation job.');
        }

        const result = await runPythonScript(
          'search_generator.py',
          {
            target_date: targetDate,
            batch_sequence: batchSequence,
            r2_output_key: r2OutputKey,
          },
          requestId
        );

        await pool.query(
          `UPDATE ckyc_batches
           SET status = 'GENERATED',
               search_file_key = $2,
               pan_dob_r2_key = $3,
               error_message = NULL
           WHERE id = $1 AND status = 'PROCESSING'`,
          [batchId, result.r2_key_written || r2OutputKey, result.pan_dob_r2_key || null]
        );

        await appendBatchTimeline({
          batchId,
          type: 'search_generated',
          metadata: {
            target_date: targetDate,
            batch_sequence: batchSequence,
            record_count: result.record_count || 0,
            r2_key: result.r2_key_written || r2OutputKey,
          },
        });

        sendGeneratedAlert({
          targetDate,
          batchSequence,
          recordCount: result.record_count || 0,
          batchId,
        }).catch(() => {});
      } catch (err) {
        const sanitizedError = sanitizePAN(err.message || 'Unknown error', 500);

        await pool.query(
          `UPDATE ckyc_batches
           SET status = 'FAILED',
               error_message = $2
           WHERE id = $1`,
          [batchId, sanitizedError]
        );

        await appendBatchTimeline({
          batchId,
          type: 'batch_failed',
          metadata: {
            target_date: targetDate,
            batch_sequence: batchSequence,
            stage: 'search_generation',
            error: sanitizedError,
          },
        });

        sendFailedAlert({
          targetDate,
          batchSequence,
          stage: 'search_generation',
          errorMessage: sanitizedError,
          batchId,
        }).catch(() => {});

        throw err;
      }
    },
    {
      connection: createRedisClient(),
      concurrency: 1,
      stalledInterval: 300000,
      maxStalledCount: 1,
      drainDelay: 1,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      level: 'ERROR',
      worker: 'searchGen',
      jobId: job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

module.exports = { createSearchGenWorker };
