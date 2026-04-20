'use strict';

const { Worker } = require('bullmq');
const { pool } = require('../config/database');
const { createRedisClient } = require('../config/redis');
const { QUEUE_NAMES } = require('./queue');
const { runPythonScript } = require('../utils/ipcRunner');
const { sanitizePAN } = require('../utils/panSanitizer');
const { sendFailedAlert } = require('../services/email.service');
const { r2Paths } = require('../utils/r2Paths');
const { _trySetFinalFilesReady } = require('./bulkDownload.worker');
const { getNextFileSequence } = require('../utils/fileSequence');
const { formatDateForFilename, todayIST } = require('../utils/istTime');
const { appendBatchTimeline } = require('../services/timeline.service');

function createUploadGenWorker() {
  const worker = new Worker(
    QUEUE_NAMES.UPLOAD_GENERATION,
    async (job) => {
      const { batchId, targetDate, batchSequence, requestId } = job.data;

      try {
        const batchResult = await pool.query(
          `SELECT response_analysis_result
           FROM ckyc_batches
           WHERE id = $1`,
          [batchId]
        );

        if (batchResult.rows.length === 0) {
          throw new Error(`Batch ${batchId} not found`);
        }

        const analysisResult = batchResult.rows[0].response_analysis_result;
        if (!analysisResult || !analysisResult.upload_list) {
          throw new Error(`No upload_list found in response_analysis_result for batch ${batchId}`);
        }

        const fileSeq = await getNextFileSequence('upload');
        const today = todayIST();
        const dateStr = formatDateForFilename(today);
        const r2OutputKeyPrefix = r2Paths.prefix(targetDate, 'upload');

        const result = await runPythonScript(
          'upload_generator.py',
          {
            target_date: targetDate,
            batch_sequence: fileSeq,
            pan_list: analysisResult.upload_list,
            r2_output_key_prefix: r2OutputKeyPrefix,
            filename_date: dateStr,
          },
          requestId
        );

        const primaryKey = result.files_generated?.[0]?.r2_key
          || `${r2OutputKeyPrefix}IN3860_IT_${dateStr}_V1.3_U${String(fileSeq).padStart(5, '0')}.zip`;

        await pool.query(
          `UPDATE ckyc_batches
           SET upload_file_key = $2
           WHERE id = $1`,
          [batchId, primaryKey]
        );

        await appendBatchTimeline({
          batchId,
          type: 'upload_file_ready',
          metadata: {
            target_date: targetDate,
            file_sequence: fileSeq,
            files_generated: result.files_generated?.length || 0,
            r2_key: primaryKey,
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
            stage: 'upload_generation',
            error: sanitizedError,
          },
        });

        sendFailedAlert({
          targetDate,
          batchSequence,
          stage: 'upload_generation',
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
      worker: 'uploadGen',
      jobId: job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

module.exports = { createUploadGenWorker };
