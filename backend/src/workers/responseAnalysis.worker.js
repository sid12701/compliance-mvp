// backend/src/workers/responseAnalysis.worker.js
'use strict';

const { Worker }                  = require('bullmq');
const { pool }                    = require('../config/database');
const { createRedisClient }       = require('../config/redis');
const { QUEUE_NAMES,
        enqueueBulkDownload,
        enqueueUploadGeneration } = require('./queue');
const { runPythonScript }         = require('../utils/ipcRunner');
const { sanitizePAN }             = require('../utils/panSanitizer');
const { AUDIT_ACTIONS }           = require('../constants/auditActions');
const r2Service                   = require('../services/r2.service');

function createResponseAnalysisWorker() {
  const worker = new Worker(
    QUEUE_NAMES.RESPONSE_ANALYSIS,
    async (job) => {
      const { batchId, targetDate, batchSequence, responseFileKey, requestId } = job.data;

      console.log(JSON.stringify({
        level:     'INFO',
        timestamp: new Date().toISOString(),
        worker:    'responseAnalysis',
        batchId,
        message:   `Starting response analysis for ${targetDate}`,
      }));

      try {
        // ── Fetch response file from R2 ────────────────────────
        // Python never holds R2 credentials.
        // Node.js fetches the file and passes contents via stdin.
        const fileBuffer = await r2Service.getObject(responseFileKey);
        const fileBase64 = fileBuffer.toString('base64');

        // ── Run Python script ──────────────────────────────────
        const result = await runPythonScript(
          'response_analyzer.py',
          {
            target_date:           targetDate,
            batch_sequence:        batchSequence,
            response_file_content: fileBase64,
          },
          requestId
        );

        // result shape:
        // {
        //   success: true,
        //   download_list: [{ pan, ckyc_no }, ...],
        //   upload_list: [pan, ...],
        //   download_count: N,
        //   upload_count: N,
        //   analyzed_at: ISO string
        // }

        // ── Save analysis result to DB ─────────────────────────
        // PANs stored in JSONB — NOT in the queue payload
        const analysisResult = {
          download_list:  result.download_list  || [],
          upload_list:    result.upload_list    || [],
          download_count: result.download_count || 0,
          upload_count:   result.upload_count   || 0,
          analyzed_at:    result.analyzed_at    || new Date().toISOString(),
        };

        await pool.query(
          `UPDATE ckyc_batches
           SET response_analysis_result = $2
           WHERE id = $1`,
          [batchId, JSON.stringify(analysisResult)]
        );

        // ── Enqueue both downstream jobs in parallel ───────────
        // Both jobs read PANs from response_analysis_result in DB
        // using batchId — no PAN data in queue payloads
        await Promise.all([
          enqueueBulkDownload({
            batchId,
            targetDate,
            batchSequence,
            requestId,
          }),
          enqueueUploadGeneration({
            batchId,
            targetDate,
            batchSequence,
            requestId,
          }),
        ]);

        // ── Write audit log ────────────────────────────────────
        await _insertAuditLog({
          action:   AUDIT_ACTIONS.RESPONSE_PROCESSED,
          batchId,
          metadata: {
            target_date:    targetDate,
            download_count: analysisResult.download_count,
            upload_count:   analysisResult.upload_count,
          },
        });

        console.log(JSON.stringify({
          level:          'INFO',
          timestamp:      new Date().toISOString(),
          worker:         'responseAnalysis',
          batchId,
          message:        'Response analysis complete — downstream jobs enqueued',
          download_count: analysisResult.download_count,
          upload_count:   analysisResult.upload_count,
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
            stage:       'response_analysis',
          },
        });

        throw err;
      }
    },
    {
      connection:  createRedisClient(),
      concurrency: 2, // Two response analysis jobs can run simultaneously
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      level:   'ERROR',
      worker:  'responseAnalysis',
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

module.exports = { createResponseAnalysisWorker };