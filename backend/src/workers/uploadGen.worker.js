// backend/src/workers/uploadGen.worker.js
'use strict';

const { Worker }                = require('bullmq');
const { pool }                  = require('../config/database');
const { createRedisClient }     = require('../config/redis');
const { QUEUE_NAMES }           = require('./queue');
const { runPythonScript }       = require('../utils/ipcRunner');
const { sanitizePAN }           = require('../utils/panSanitizer');
const { AUDIT_ACTIONS }         = require('../constants/auditActions');
const { insertAuditLog }        = require('../services/audit.service');
const { sendFailedAlert }       = require('../services/email.service');
const { r2Paths }               = require('../utils/r2Paths');
const { _trySetCompleted }      = require('./bulkDownload.worker');
const { getNextFileSequence }   = require('../utils/fileSequence');
const { formatDateForFilename,
        todayIST }              = require('../utils/istTime');

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
          throw new Error(
            `No upload_list found in response_analysis_result for batch ${batchId}`
          );
        }

        // ── Get today's next upload sequence ───────────────────
        // Filename uses today's date + today's sequence
        // but file is stored in targetDate's R2 folder
        const fileSeq   = await getNextFileSequence('upload');
        const seqStr    = String(fileSeq).padStart(5, '0');
        const today     = todayIST();
        const dateStr   = formatDateForFilename(today)

        // R2 prefix uses targetDate folder, filename uses today's date
        const r2OutputKeyPrefix = r2Paths.prefix(targetDate, 'upload');

        // ── Run Python script ──────────────────────────────────
        const result = await runPythonScript(
          'upload_generator.py',
          {
            target_date:          targetDate,
            batch_sequence:       fileSeq,
            pan_list:             analysisResult.upload_list,
            r2_output_key_prefix: r2OutputKeyPrefix,
            filename_date:        dateStr,   // today's date for filename
          },
          requestId
        );

        const primaryKey = result.files_generated?.[0]?.r2_key
          || `${r2OutputKeyPrefix}IN3860_IT_${dateStr}_V1.3_U${seqStr}.zip`;

        // ── Update upload_file_key ─────────────────────────────
        await pool.query(
          `UPDATE ckyc_batches
           SET upload_file_key = $2
           WHERE id = $1`,
          [batchId, primaryKey]
        );

        // ── Try to set COMPLETED ───────────────────────────────
        await _trySetCompleted(batchId);

        await insertAuditLog({
          action:   AUDIT_ACTIONS.BATCH_GENERATED,
          batchId,
          metadata: {
            target_date:    targetDate,
            file_sequence:  fileSeq,
            files_generated: result.files_generated?.length || 0,
            stage:          'upload_generation',
          },
        });

        console.log(JSON.stringify({
          level:           'INFO',
          timestamp:       new Date().toISOString(),
          worker:          'uploadGen',
          batchId,
          message:         'Upload generation complete',
          file_seq:        fileSeq,
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

        await insertAuditLog({
          action:   AUDIT_ACTIONS.BATCH_FAILED,
          batchId,
          metadata: {
            target_date: targetDate,
            error:       sanitizedError,
            stage:       'upload_generation',
          },
        });

        sendFailedAlert({
          targetDate,
          batchSequence,
          stage:        'upload_generation',
          errorMessage: sanitizedError,
          batchId,
        }).catch(() => {});

        throw err;
      }
    },
    {
      connection:      createRedisClient(),
      concurrency:     1,          // (or 2 — keep as-is per worker)
      stalledInterval: 300000,     // check stalled jobs every 5 min
      maxStalledCount: 1,
      drainDelay:      1,          // 0 = use blocking pop (push-based, no polling)
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

module.exports = { createUploadGenWorker };