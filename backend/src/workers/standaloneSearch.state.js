'use strict';

const { EventEmitter } = require('events');
const { randomUUID }   = require('crypto');

const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _jobs   = new Map(); // jobId -> { status, result, error, streamToken, createdAt }
const _events = new EventEmitter();

function createStandaloneSearchJob() {
  const jobId       = randomUUID();
  const streamToken = randomUUID();
  const record = {
    jobId,
    streamToken,
    status:    'PENDING',
    createdAt: Date.now(),
  };
  _jobs.set(jobId, record);

  const timer = setTimeout(() => {
    _jobs.delete(jobId);
  }, JOB_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return { jobId, streamToken };
}

function getStandaloneSearchJob(jobId) {
  return _jobs.get(jobId) || null;
}

function completeStandaloneSearchJob(jobId, result) {
  const job = _jobs.get(jobId);
  if (!job) return;
  job.status = 'COMPLETED';
  job.result = result;
  _events.emit(jobId, { status: 'COMPLETED', result });
}

function failStandaloneSearchJob(jobId, errorMessage) {
  const job = _jobs.get(jobId);
  if (!job) return;
  job.status = 'FAILED';
  job.error  = errorMessage;
  _events.emit(jobId, { status: 'FAILED', error: errorMessage });
}

function waitForStandaloneSearchJob(jobId, listener) {
  _events.once(jobId, listener);
}

function removeStandaloneSearchListener(jobId, listener) {
  _events.removeListener(jobId, listener);
}

module.exports = {
  createStandaloneSearchJob,
  getStandaloneSearchJob,
  completeStandaloneSearchJob,
  failStandaloneSearchJob,
  waitForStandaloneSearchJob,
  removeStandaloneSearchListener,
};
