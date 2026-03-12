// backend/src/constants/auditActions.js
'use strict';

// ── All 14 auditable actions ──────────────────────────────────────
// These strings are CHECK-constrained at the DB level in migration 003.
// If you add a new action here you MUST also add it to the CHECK
// constraint via a new migration — otherwise the DB insert will fail.
//
// Actor key:
//   USER   = written by an Express route handler (user_id populated)
//   SYSTEM = written by a BullMQ worker (user_id = NULL)

const AUDIT_ACTIONS = Object.freeze({

  // ── Authentication ─────────────────────────────────────────────
  LOGIN:                         'LOGIN',                         // USER
  LOGIN_FAILED:                  'LOGIN_FAILED',                  // USER (null user_id)
  LOGOUT:                        'LOGOUT',                        // USER

  // ── Batch viewing ──────────────────────────────────────────────
  BATCH_ACCESSED:                'BATCH_ACCESSED',                // USER

  // ── Search file generation ─────────────────────────────────────
  MANUAL_GENERATION_TRIGGERED:   'MANUAL_GENERATION_TRIGGERED',   // USER
  BATCH_GENERATED:               'BATCH_GENERATED',               // SYSTEM

  // ── Search file download ───────────────────────────────────────
  // Two entries per download: intent (requested) + outcome (issued)
  SEARCH_FILE_URL_REQUESTED:     'SEARCH_FILE_URL_REQUESTED',     // USER
  SEARCH_FILE_DOWNLOADED:        'SEARCH_FILE_DOWNLOADED',        // USER

  // ── CKYC portal upload confirmation ───────────────────────────
  CKYC_UPLOAD_CONFIRMED:         'CKYC_UPLOAD_CONFIRMED',         // USER

  // ── Response file handling ─────────────────────────────────────
  // Intent: ops requests upload URL + filename validated
  RESPONSE_UPLOAD_INITIATED:     'RESPONSE_UPLOAD_INITIATED',     // USER
  // Outcome: ops calls process-response, file confirmed in R2
  RESPONSE_FILE_UPLOADED:        'RESPONSE_FILE_UPLOADED',        // USER
  // System outcome: both final files written to R2
  RESPONSE_PROCESSED:            'RESPONSE_PROCESSED',            // SYSTEM

  // ── Final file download ────────────────────────────────────────
  FINAL_FILE_DOWNLOADED:         'FINAL_FILE_DOWNLOADED',         // USER

  // ── Failure ────────────────────────────────────────────────────
  BATCH_FAILED:                  'BATCH_FAILED',                  // SYSTEM

});

module.exports = { AUDIT_ACTIONS };