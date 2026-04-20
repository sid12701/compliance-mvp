'use strict';

const { Worker } = require('bullmq');
const { pool } = require('../config/database');
const { createRedisClient } = require('../config/redis');
const { QUEUE_NAMES } = require('./queue');
const { runPythonScript } = require('../utils/ipcRunner');
const { sanitizePAN } = require('../utils/panSanitizer');
const { sendFailedAlert } = require('../services/email.service');
const { r2Paths } = require('../utils/r2Paths');
const { formatDateForFilename, todayIST } = require('../utils/istTime');
const { getNextFileSequence } = require('../utils/fileSequence');
const { appendBatchTimeline } = require('../services/timeline.service');

function createBulkDownloadWorker() {
  const worker = new Worker(
    QUEUE_NAMES.BULK_DOWNLOAD,
    async (job) => {
      const { batchId, targetDate, batchSequence, requestId } = job.data;

      try {
        const batchResult = await pool.query(
          `SELECT response_file_key, pan_dob_r2_key, batch_sequence
           FROM ckyc_batches WHERE id = $1`,
          [batchId]
        );

        if (batchResult.rows.length === 0) {
          throw new Error(`Batch ${batchId} not found`);
        }

        const { response_file_key, pan_dob_r2_key } = batchResult.rows[0];

        if (!response_file_key) {
          throw new Error(`No response_file_key found for batch ${batchId}`);
        }

        if (!pan_dob_r2_key) {
          throw new Error(`No pan_dob_r2_key found for batch ${batchId}`);
        }

        const fileSeq = await getNextFileSequence('download');
        const dateStr = formatDateForFilename(todayIST());
        const filename = `IN3860_IT_${dateStr}_V1.3_D${String(fileSeq).padStart(5, '0')}.txt`;
        const r2OutputKey = r2Paths.downloadFile(targetDate, filename);

        const result = await runPythonScript(
          'bulk_download.py',
          {
            target_date: targetDate,
            batch_sequence: batchSequence,
            response_r2_key: response_file_key,
            pan_dob_r2_key,
            r2_output_key: r2OutputKey,
          },
          requestId
        );

        await pool.query(
          `UPDATE ckyc_batches
           SET download_file_key = $2
           WHERE id = $1`,
          [batchId, result.r2_key_written || r2OutputKey]
        );

        await appendBatchTimeline({
          batchId,
          type: 'download_file_ready',
          metadata: {
            target_date: targetDate,
            record_count: result.record_count || 0,
            r2_key: result.r2_key_written || r2OutputKey,
          },
        });

        await _trySetFinalFilesReady(batchId);
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
            stage: 'bulk_download',
            error: sanitizedError,
          },
        });

        sendFailedAlert({
          targetDate,
          batchSequence,
          stage: 'bulk_download',
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
      worker: 'bulkDownload',
      jobId: job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

async function _trySetFinalFilesReady(batchId) {
  const result = await pool.query(
    `UPDATE ckyc_batches
     SET status = 'FINAL_FILES_READY'
     WHERE id = $1
       AND download_file_key IS NOT NULL
       AND upload_file_key IS NOT NULL
       AND status = 'PROCESSING_RESPONSE'
     RETURNING id`,
    [batchId]
  );

  if (result.rows.length > 0) {
    await appendBatchTimeline({
      batchId,
      type: 'final_files_ready',
      metadata: {
        status_after: 'FINAL_FILES_READY',
      },
    });
  }
}

module.exports = { createBulkDownloadWorker, _trySetFinalFilesReady };
