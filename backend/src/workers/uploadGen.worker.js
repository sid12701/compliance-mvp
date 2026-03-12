// backend/src/workers/uploadGen.worker.js
'use strict';

const { Worker }            = require('bullmq');
const { pool }              = require('../config/database');
const { createRedisClient } = require('../config/redis');
const { QUEUE_NAMES }       = require('./queue');
const { runPythonScript }   = require('../utils/ipcRunner');
const { sanitizePAN }       = require('../utils/panSanitizer');
const { AUDIT_ACTIONS }     = require('../constants/auditActions');
const { r2Paths }           = require('../utils/r2Paths');
const { formatDateForFilename } = require('../utils/istTime');
const { _trySetCompleted }  = require('./bulkDownload.worker');

function createUploadGenWorker() {
  const worker = new Worker(
    QUEUE_NAMES.UPLOAD_GENERATION,
    async (job) => {
      const { batchId, targetDate, batchSequence, requestId } = job.data;

      console.log(JSON.stringify({
        level:     'INFO',
        timestamp: new Date().toISOString(),
        worker:    'uploadGen',
        batchId,
        message:   `Starting upload generation for ${targetDate}`,
      }));

      try {
        // ── Fetch upload_list from DB ──────────────────────────
        const batchResult = await pool.query(
          `SELECT response_analysis_result FROM ckyc_batches WHERE id = $1`,
          [batchId]
        );

        if (batchResult.rows.length === 0) {
          throw new Error(`Batch ${batchId} not found`);
        }

        const analysisResult = batchResult.rows[0].response_analysis_result;
        if (!analysisResult || !analysisResult.upload_list) {
          throw new Error(`No upload_list found in response_analysis_result for batch ${batchId}`);
        }

        // ── Build R2 output key prefix ─────────────────────────
        // upload_generator.py may produce multiple files
        // We pass a prefix and let Python append its own filenames
        const r2OutputKeyPrefix = r2Paths.prefix(targetDate, 'upload');

        // ── Run Python script ──────────────────────────────────
        const result = await runPythonScript(
          'upload_generator.py',
          {
            target_date:          targetDate,
            batch_sequence:       batchSequence,
            pan_list:             analysisResult.upload_list,
            r2_output_key_prefix: r2OutputKeyPrefix,
          },
          requestId
        );

        // result.files_generated = [{ r2_key, file_size_bytes }, ...]
        // Use the first file as the primary upload_file_key
        // If multiple files, they are all in R2 under the prefix
        const primaryKey = result.files_generated?.[0]?.r2_key
          || `${r2OutputKeyPrefix}upload_${batchSequence}.zip`;

        // ── Update upload_file_key ─────────────────────────────
        await pool.query(
          `UPDATE ckyc_batches
           SET upload_file_key = $2
           WHERE id = $1`,
          [batchId, primaryKey]
        );

        // ── Try to set COMPLETED ───────────────────────────────
        await _trySetCompleted(batchId);

        console.log(JSON.stringify({
          level:           'INFO',
          timestamp:       new Date().toISOString(),
          worker:          'uploadGen',
          batchId,
          message:         'Upload generation complete',
          files_generated: result.files_generated?.length || 0,
        }));

      } catch (err) {
        const sanitizedError = sanitizePAN(err.message || 'Unknown error', 500);

        await pool.query(
          `UPDATE ckyc_batches
           SET status        = 'FAILED',
               error_message = $2
           WHERE id = $1`,
          [batchId, sanitizedError]
        );

        await _insertAuditLog({
          action:   AUDIT_ACTIONS.BATCH_FAILED,
          batchId,
          metadata: {
            target_date: targetDate,
            error:       sanitizedError,
            stage:       'upload_generation',
          },
        });

        throw err;
      }
    },
    {
      connection:  createRedisClient(),
      concurrency: 1, // Gmail-heavy — one at a time to avoid rate limits
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      level:   'ERROR',
      worker:  'uploadGen',
      jobId:   job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

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

module.exports = { createUploadGenWorker };