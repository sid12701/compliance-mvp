'use strict';

const BATCH_STATUS = Object.freeze({
  PROCESSING:          'PROCESSING',
  GENERATED:           'GENERATED',
  DOWNLOADED:          'DOWNLOADED',
  WAITING_RESPONSE:    'WAITING_RESPONSE',
  PROCESSING_RESPONSE: 'PROCESSING_RESPONSE',
  FINAL_FILES_READY:   'FINAL_FILES_READY',
  COMPLETED:           'COMPLETED',
  FAILED:              'FAILED',
});

const VALID_TRANSITIONS = Object.freeze({
  [BATCH_STATUS.PROCESSING]:          [BATCH_STATUS.GENERATED, BATCH_STATUS.FAILED],
  [BATCH_STATUS.GENERATED]:           [BATCH_STATUS.DOWNLOADED],
  [BATCH_STATUS.DOWNLOADED]:          [BATCH_STATUS.WAITING_RESPONSE],
  [BATCH_STATUS.WAITING_RESPONSE]:    [BATCH_STATUS.PROCESSING_RESPONSE],
  [BATCH_STATUS.PROCESSING_RESPONSE]: [BATCH_STATUS.FINAL_FILES_READY, BATCH_STATUS.FAILED],
  [BATCH_STATUS.FINAL_FILES_READY]:   [BATCH_STATUS.COMPLETED],
  [BATCH_STATUS.COMPLETED]:           [],
  [BATCH_STATUS.FAILED]:              [BATCH_STATUS.PROCESSING],
});

function assertValidTransition(currentStatus, nextStatus) {
  const allowedNextStates = VALID_TRANSITIONS[currentStatus];

  if (!allowedNextStates) {
    const err = new Error(`Unknown batch status: "${currentStatus}"`);
    err.statusCode = 500;
    err.code = 'INTERNAL_ERROR';
    throw err;
  }

  if (!allowedNextStates.includes(nextStatus)) {
    const err = new Error(
      `Cannot transition batch from "${currentStatus}" to "${nextStatus}". ` +
      `Valid next states: [${allowedNextStates.join(', ') || 'none - terminal state'}]`
    );
    err.statusCode = 409;
    err.code = 'INVALID_STATE_TRANSITION';
    throw err;
  }
}

function isTerminalState(status) {
  return VALID_TRANSITIONS[status]?.length === 0;
}

const SEARCH_DOWNLOAD_ELIGIBLE = Object.freeze([
  BATCH_STATUS.GENERATED,
  BATCH_STATUS.DOWNLOADED,
  BATCH_STATUS.WAITING_RESPONSE,
  BATCH_STATUS.PROCESSING_RESPONSE,
  BATCH_STATUS.FINAL_FILES_READY,
  BATCH_STATUS.COMPLETED,
]);

const FINAL_DOWNLOAD_ELIGIBLE = Object.freeze([
  BATCH_STATUS.FINAL_FILES_READY,
  BATCH_STATUS.COMPLETED,
]);

module.exports = {
  BATCH_STATUS,
  VALID_TRANSITIONS,
  assertValidTransition,
  isTerminalState,
  SEARCH_DOWNLOAD_ELIGIBLE,
  FINAL_DOWNLOAD_ELIGIBLE,
};
