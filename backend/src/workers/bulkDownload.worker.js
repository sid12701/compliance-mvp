// backend/src/workers/bulkDownload.worker.js
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

function createBulkDownloadWorker() {
  const worker = new Worker(
    QUEUE_NAMES.BULK_DOWNLOAD,
    async (job) => {
      const { batchId, targetDate, batchSequence, requestId } = job.data;

      console.log(JSON.stringify({
        level:     'INFO',
        timestamp: new Date().toISOString(),
        worker:    'bulkDownload',
        batchId,
        message:   `Starting bulk download for ${targetDate}`,
      }));

      try {
        // ── Fetch download_list from DB ────────────────────────
        // PANs are read from DB — never passed through queue payload
        const batchResult = await pool.query(
          `SELECT response_analysis_result, batch_sequence
           FROM ckyc_batches WHERE id = $1`,
          [batchId]
        );

        if (batchResult.rows.length === 0) {
          throw new Error(`Batch ${batchId} not found`);
        }

        const analysisResult = batchResult.rows[0].response_analysis_result;
        if (!analysisResult || !analysisResult.download_list) {
          throw new Error(`No download_list found in response_analysis_result for batch ${batchId}`);
        }

        // ── Build R2 output key ────────────────────────────────
        const seq      = String(batchSequence).padStart(5, '0');
        const dateStr  = formatDateForFilename(targetDate);
        const filename = `IN3860_${dateStr}_V1.1_S${seq}.txt`;
        const r2OutputKey = r2Paths.downloadFile(targetDate, filename);

        // ── Run Python script ──────────────────────────────────
        const result = await runPythonScript(
          'bulk_download.py',
          {
            target_date:    targetDate,
            batch_sequence: batchSequence,
            download_list:  analysisResult.download_list,
            r2_output_key:  r2OutputKey,
          },
          requestId
        );

        // ── Update download_file_key ───────────────────────────
        await pool.query(
          `UPDATE ckyc_batches
           SET download_file_key = $2
           WHERE id = $1`,
          [batchId, result.r2_key_written || r2OutputKey]
        );

        // ── Try to set COMPLETED (atomic — see pattern explanation above)
        await _trySetCompleted(batchId);

        console.log(JSON.stringify({
          level:        'INFO',
          timestamp:    new Date().toISOString(),
          worker:       'bulkDownload',
          batchId,
          message:      'Bulk download complete',
          record_count: result.record_count || 0,
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
            stage:       'bulk_download',
          },
        });

        throw err;
      }
    },
    {
      connection:  createRedisClient(),
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      level:   'ERROR',
      worker:  'bulkDownload',
      jobId:   job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

// ── Atomic completion check ───────────────────────────────────────
// Sets status = COMPLETED only when BOTH file keys are present.
// Safe to call from both bulkDownload and uploadGen workers —
// only the second one to complete will actually update the row.
async function _trySetCompleted(batchId) {
  const result = await pool.query(
    `UPDATE ckyc_batches
     SET status = 'COMPLETED'
     WHERE id                  = $1
       AND download_file_key   IS NOT NULL
       AND upload_file_key     IS NOT NULL
       AND status              = 'PROCESSING_RESPONSE'
     RETURNING id`,
    [batchId]
  );

  if (result.rows.length > 0) {
    console.log(JSON.stringify({
      level:     'INFO',
      timestamp: new Date().toISOString(),
      message:   `Batch ${batchId} → COMPLETED`,
    }));
  }
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

module.exports = { createBulkDownloadWorker, _trySetCompleted };