'use strict';

const { Worker } = require('bullmq');
const { pool } = require('../config/database');
const { createRedisClient } = require('../config/redis');
const {
  QUEUE_NAMES,
  enqueueBulkDownload,
  enqueueUploadGeneration,
} = require('./queue');
const { runPythonScript } = require('../utils/ipcRunner');
const { sanitizePAN } = require('../utils/panSanitizer');
const { sendFailedAlert } = require('../services/email.service');
const r2Service = require('../services/r2.service');
const { appendBatchTimeline } = require('../services/timeline.service');

function createResponseAnalysisWorker() {
  const worker = new Worker(
    QUEUE_NAMES.RESPONSE_ANALYSIS,
    async (job) => {
      const { batchId, targetDate, batchSequence, responseFileKey, requestId } = job.data;

      try {
        const fileBuffer = await r2Service.getObject(responseFileKey);
        const fileBase64 = fileBuffer.toString('base64');

        const result = await runPythonScript(
          'response_analyzer.py',
          {
            target_date: targetDate,
            batch_sequence: batchSequence,
            response_file_content: fileBase64,
          },
          requestId
        );

        const analysisResult = {
          download_list: result.download_list || [],
          upload_list: result.upload_list || [],
          download_count: result.download_count || 0,
          upload_count: result.upload_count || 0,
          analyzed_at: result.analyzed_at || new Date().toISOString(),
        };

        await pool.query(
          `UPDATE ckyc_batches
           SET response_analysis_result = $2
           WHERE id = $1`,
          [batchId, JSON.stringify(analysisResult)]
        );

        await Promise.all([
          enqueueBulkDownload({ batchId, targetDate, batchSequence, requestId }),
          enqueueUploadGeneration({ batchId, targetDate, batchSequence, requestId }),
        ]);

        await appendBatchTimeline({
          batchId,
          type: 'response_processed',
          metadata: {
            target_date: targetDate,
            download_count: analysisResult.download_count,
            upload_count: analysisResult.upload_count,
          },
        });
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
            stage: 'response_analysis',
            error: sanitizedError,
          },
        });

        sendFailedAlert({
          targetDate,
          batchSequence,
          stage: 'response_analysis',
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
      worker: 'responseAnalysis',
      jobId: job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

module.exports = { createResponseAnalysisWorker };
