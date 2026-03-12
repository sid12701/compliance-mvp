// backend/src/constants/batchStatus.js
'use strict';

// ── The 7 valid batch states ──────────────────────────────────────
// Object.freeze() makes this immutable at runtime.
// Any attempt to add or modify a value is silently ignored
// in non-strict mode and throws in strict mode.
const BATCH_STATUS = Object.freeze({
  PROCESSING:            'PROCESSING',
  GENERATED:             'GENERATED',
  DOWNLOADED:            'DOWNLOADED',
  WAITING_RESPONSE:      'WAITING_RESPONSE',
  PROCESSING_RESPONSE:   'PROCESSING_RESPONSE',
  COMPLETED:             'COMPLETED',
  FAILED:                'FAILED',
});

// ── Valid state transition map ────────────────────────────────────
// Key   = current status
// Value = array of statuses this batch is allowed to move TO
//
// Reading this map tells you the entire business flow:
//   PROCESSING → Python finishes       → GENERATED
//   PROCESSING → Python fails          → FAILED
//   GENERATED  → Ops downloads         → DOWNLOADED
//   DOWNLOADED → Ops confirms upload   → WAITING_RESPONSE
//   WAITING_RESPONSE → Response uploaded → PROCESSING_RESPONSE
//   PROCESSING_RESPONSE → Jobs finish  → COMPLETED
//   PROCESSING_RESPONSE → Jobs fail    → FAILED
//   FAILED     → Manual re-trigger     → PROCESSING  (only recovery path)
//   COMPLETED  → nothing               → terminal state

const VALID_TRANSITIONS = Object.freeze({
  [BATCH_STATUS.PROCESSING]:          [BATCH_STATUS.GENERATED,  BATCH_STATUS.FAILED],
  [BATCH_STATUS.GENERATED]:           [BATCH_STATUS.DOWNLOADED],
  [BATCH_STATUS.DOWNLOADED]:          [BATCH_STATUS.WAITING_RESPONSE],
  [BATCH_STATUS.WAITING_RESPONSE]:    [BATCH_STATUS.PROCESSING_RESPONSE],
  [BATCH_STATUS.PROCESSING_RESPONSE]: [BATCH_STATUS.COMPLETED,  BATCH_STATUS.FAILED],
  [BATCH_STATUS.COMPLETED]:           [],   // terminal — no further transitions
  [BATCH_STATUS.FAILED]:              [BATCH_STATUS.PROCESSING], // re-trigger only
});

// ── Transition guard function ─────────────────────────────────────
// Called before every status update in batch.service.js.
// Throws a structured error if the transition is not in the map.
// Never throws for valid transitions — returns void.
//
// Usage:
//   assertValidTransition('GENERATED', 'DOWNLOADED')  // ok
//   assertValidTransition('GENERATED', 'COMPLETED')   // throws 409
function assertValidTransition(currentStatus, nextStatus) {
  const allowedNextStates = VALID_TRANSITIONS[currentStatus];

  // Unknown current status — should never happen if DB constraint is working
  if (!allowedNextStates) {
    const err = new Error(`Unknown batch status: "${currentStatus}"`);
    err.statusCode = 500;
    err.code = 'INTERNAL_ERROR';
    throw err;
  }

  if (!allowedNextStates.includes(nextStatus)) {
    const err = new Error(
      `Cannot transition batch from "${currentStatus}" to "${nextStatus}". ` +
      `Valid next states: [${allowedNextStates.join(', ') || 'none — terminal state'}]`
    );
    err.statusCode = 409;
    err.code = 'INVALID_STATE_TRANSITION';
    throw err;
  }
}

// ── Terminal state check ──────────────────────────────────────────
// Convenience helper used in route handlers to reject actions
// on batches that are already done.
function isTerminalState(status) {
  return VALID_TRANSITIONS[status]?.length === 0;
}

// ── Download-eligible state check ────────────────────────────────
// The search file download endpoint accepts GENERATED or DOWNLOADED.
// This is the one case where an action is valid across two states.
const SEARCH_DOWNLOAD_ELIGIBLE = Object.freeze([
  BATCH_STATUS.GENERATED,
  BATCH_STATUS.DOWNLOADED,
]);

module.exports = {
  BATCH_STATUS,
  VALID_TRANSITIONS,
  assertValidTransition,
  isTerminalState,
  SEARCH_DOWNLOAD_ELIGIBLE,
};