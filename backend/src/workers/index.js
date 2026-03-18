// backend/src/workers/index.js
'use strict';

const { createSearchGenWorker }          = require('./searchGen.worker');
const { createResponseAnalysisWorker }   = require('./responseAnalysis.worker');
const { createBulkDownloadWorker }       = require('./bulkDownload.worker');
const { createUploadGenWorker }          = require('./uploadGen.worker');
const { createStandaloneSearchWorker }   = require('./standaloneSearch.worker');

let workers = [];

// ── Start all workers ─────────────────────────────────────────────
// Called once from src/index.js after the HTTP server starts.
function startWorkers() {
  console.log(JSON.stringify({
    level:     'INFO',
    timestamp: new Date().toISOString(),
    message:   'Starting BullMQ workers',
  }));

  workers = [
    createSearchGenWorker(),
    createResponseAnalysisWorker(),
    createBulkDownloadWorker(),
    createUploadGenWorker(),
    createStandaloneSearchWorker(),
  ];

  console.log(JSON.stringify({
    level:     'INFO',
    timestamp: new Date().toISOString(),
    message:   `${workers.length} workers started`,
    workers: [
      'searchGen',
      'responseAnalysis',
      'bulkDownload',
      'uploadGen',
      'standaloneSearch',
    ],
  }));

  return workers;
}

// ── Graceful shutdown ─────────────────────────────────────────────
// Called by SIGTERM handler in src/index.js.
// Waits for all in-progress jobs to complete before exiting.
async function shutdownWorkers() {
  console.log(JSON.stringify({
    level:     'INFO',
    timestamp: new Date().toISOString(),
    message:   'Shutting down workers gracefully...',
  }));

  await Promise.allSettled(workers.map((w) => w.close()));

  console.log(JSON.stringify({
    level:     'INFO',
    timestamp: new Date().toISOString(),
    message:   'All workers shut down',
  }));
}

module.exports = { startWorkers, shutdownWorkers };
