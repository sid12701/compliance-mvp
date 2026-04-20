'use strict';

const { Worker }                 = require('bullmq');
const { createRedisClient }      = require('../config/redis');
const { QUEUE_NAMES }            = require('./queue');
const { runPythonScript }        = require('../utils/ipcRunner');
const { sanitizePAN }            = require('../utils/panSanitizer');
const { r2Paths }                = require('../utils/r2Paths');
const { getNextFileSequence }    = require('../utils/fileSequence');
const { formatDateForFilename,
        todayIST }               = require('../utils/istTime');
const r2Service                  = require('../services/r2.service');

function createStandaloneSearchWorker() {
  const worker = new Worker(
    QUEUE_NAMES.STANDALONE_SEARCH,
    async (job) => {
      const { jobId, targetDate, requestId } = job.data;

      try {
        // Build filename with today's date + next sequence
        const fileSeq  = await getNextFileSequence('search');
        const seqStr   = String(fileSeq).padStart(5, '0');
        const today    = todayIST();
        const dateStr  = formatDateForFilename(today);
        const filename = `IN3860_${dateStr}_V1.1_S${seqStr}.txt`;
        const r2OutputKey = r2Paths.searchFile(targetDate, filename);

        const result = await runPythonScript(
          'search_generator.py',
          {
            target_date:    targetDate,
            batch_sequence: fileSeq,
            r2_output_key:  r2OutputKey,
          },
          requestId
        );

        const { url, expiresAt } = await r2Service.getPresignedDownloadUrl(
          r2OutputKey,
          filename
        );

        return {
          url,
          filename,
          expires_at:   expiresAt,
          record_count: result.record_count,
          r2_key:       r2OutputKey,
        };
      } catch (err) {
        const sanitizedError = sanitizePAN(err.message || 'Unknown error', 500);
        throw new Error(sanitizedError);
      }
    },
    {
      connection:      createRedisClient(),
      concurrency:     1,
      stalledInterval: 300000,
      maxStalledCount: 1,
      drainDelay:      1,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(JSON.stringify({
      level:   'ERROR',
      worker:  'standaloneSearch',
      jobId:   job?.id,
      message: `Job permanently failed: ${sanitizePAN(err.message)}`,
    }));
  });

  return worker;
}

module.exports = { createStandaloneSearchWorker };
