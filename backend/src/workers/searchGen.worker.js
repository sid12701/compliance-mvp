// backend/src/workers/searchGen.worker.js
'use strict';

const { Worker }              = require('bullmq');
const { pool }                = require('../config/database');
const { createRedisClient }   = require('../config/redis');
const { QUEUE_NAMES }         = require('./queue');
const { runPythonScript }     = require('../utils/ipcRunner');
const { sanitizePAN }         = require('../utils/panSanitizer');
const { AUDIT_ACTIONS }       = require('../constants/auditActions');

// ── Worker ────────────────────────────────────────────────────────
function createSearchGenWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SEARCH_GENERATION,
    async (job) => {
      const { batchId, targetDate, batchSequence, r2OutputKey, requestId } = job.data;

      console.log(JSON.stringify({
        level:     'INFO',
        timestamp: new Date().toISOString(),
        worker:    'searchGen',
        batchId,
        jobId:     job.id,
        message:   `Starting search generation for ${targetDate}`,
      }));

      try {
        // ── Run Python script ──────────────────────────────────
        const result = await runPythonScript(
          'search_generator.py',
          {
            target_date:    targetDate,
            batch_sequence: batchSequence,
            r2_output_key:  r2OutputKey,
          },
          requestId
        );

        // ── Update batch: PROCESSING → GENERATED ───────────────
        await pool.query(
          `UPDATE ckyc_batches
           SET status          = 'GENERATED',
               search_file_key = $2,
               error_message   = NULL
           WHERE id = $1 AND status = 'PROCESSING'`,
          [batchId, result.r2_key_written || r2OutputKey]
        );

        // ── Write audit log ────────────────────────────────────
        await _insertAuditLog({
          userId:   null, // system action
          action:   AUDIT_ACTIONS.BATCH_GENERATED,
          batchId,
          metadata: {
            target_date:    targetDate,
            batch_sequence: batchSequence,
            record_count:   result.record_count || 0,
            r2_key:         result.r2_key_written || r2OutputKey,
            triggered_by:   requestId === 'cron' ? 'cron' : 'manual',
          },
        });

        console.log(JSON.stringify({
          level:        'INFO',
          timestamp:    new Date().toISOString(),
          worker:       'searchGen',
          batchId,
          message:      `Search generation complete`,
          record_count: result.record_count || 0,
        }));

      } catch (err) {
        // ── Handle failure ─────────────────────────────────────
        const sanitizedError = sanitizePAN(err.message || 'Unknown error', 500);

        await pool.query(
          `UPDATE ckyc_batches
           SET status        = 'FAILED',
               error_message = $2
           WHERE id = $1`,
          [batchId, sanitizedError]
        );

        await _insertAuditLog({
          userId:   null,
          action:   AUDIT_ACTIONS.BATCH_FAILED,
          batchId,
          metadata: {
            target_date:    targetDate,
            batch_sequence: batchSequence,
            error:          sanitizedError,
            stage:          'search_generation',
          },
        });

        console.error(JSON.stringify({
          level:     'ERROR',
          timestamp: new Date().toISOString(),
          worker:    'searchGen',
          batchId,
          message:   `Search generation failed: ${sanitizedError}`,
        }));

        // Re-throw so BullMQ marks the job as failed
        throw err;
      }
    },
    {
      connection: createRedisClient(),
      concurrency: 1, // One search job at a time — prevents Gmail rate limits
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      level:   'ERROR',
      worker:  'searchGen',
      jobId:   job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

// ── Shared audit helper ───────────────────────────────────────────
async function _insertAuditLog({ userId, action, batchId, metadata }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, batch_id, ip_address, metadata)
       VALUES ($1, $2, $3, NULL, $4)`,
      [userId || null, action, batchId || null, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.error(`[Audit] INSERT failed for action "${action}":`, err.message);
  }
}

module.exports = { createSearchGenWorker };