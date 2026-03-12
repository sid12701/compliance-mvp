// backend/src/workers/searchGen.worker.js
'use strict';

const { Worker }                = require('bullmq');
const { pool }                  = require('../config/database');
const { createRedisClient }     = require('../config/redis');
const { QUEUE_NAMES }           = require('./queue');
const { runPythonScript }       = require('../utils/ipcRunner');
const { sanitizePAN }           = require('../utils/panSanitizer');
const { AUDIT_ACTIONS }         = require('../constants/auditActions');
const { insertAuditLog }        = require('../services/audit.service');
const { sendGeneratedAlert,
        sendFailedAlert }       = require('../services/email.service');

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
        await insertAuditLog({
          userId:   null,
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

        // ── Send email alert (fire-and-forget) ─────────────────
        sendGeneratedAlert({
          targetDate,
          batchSequence,
          recordCount: result.record_count || 0,
          batchId,
        }).catch(() => {});

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

        await insertAuditLog({
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

        // ── Send failure alert (fire-and-forget) ───────────────
        sendFailedAlert({
          targetDate,
          batchSequence,
          stage:        'search_generation',
          errorMessage: sanitizedError,
          batchId,
        }).catch(() => {});

        console.error(JSON.stringify({
          level:     'ERROR',
          timestamp: new Date().toISOString(),
          worker:    'searchGen',
          batchId,
          message:   `Search generation failed: ${sanitizedError}`,
        }));

        throw err;
      }
    },
    {
      connection:  createRedisClient(),
      concurrency: 1,
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

module.exports = { createSearchGenWorker };