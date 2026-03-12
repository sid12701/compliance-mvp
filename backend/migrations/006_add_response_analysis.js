// backend/migrations/006_add_response_analysis.js
'use strict';

// Adds:
// 1. response_analysis_result JSONB column — stores response_analyzer.py
//    output (download_list + upload_list) so downstream workers can
//    retrieve it reliably using only a batch_id.
//
// 2. PROCESSING_RESPONSE status — the state a batch enters when the
//    response file has been uploaded and both downstream jobs are running.
//    Distinct from PROCESSING (which means search file generation).

exports.up = async function (knex) {
  // ── Add response_analysis_result column ──────────────────────
  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD COLUMN IF NOT EXISTS response_analysis_result JSONB;
  `);

  // ── Add PROCESSING_RESPONSE to status CHECK constraint ────────
  // PostgreSQL cannot ALTER a CHECK constraint in place.
  // Must drop and recreate with the new value set.
  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP CONSTRAINT IF EXISTS chk_ckyc_batch_status;
  `);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD CONSTRAINT chk_ckyc_batch_status CHECK (status IN (
        'PROCESSING',
        'GENERATED',
        'DOWNLOADED',
        'WAITING_RESPONSE',
        'PROCESSING_RESPONSE',
        'COMPLETED',
        'FAILED'
      ));
  `);
};

exports.down = async function (knex) {
  // ── Restore CHECK constraint without PROCESSING_RESPONSE ─────
  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP CONSTRAINT IF EXISTS chk_ckyc_batch_status;
  `);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD CONSTRAINT chk_ckyc_batch_status CHECK (status IN (
        'PROCESSING',
        'GENERATED',
        'DOWNLOADED',
        'WAITING_RESPONSE',
        'COMPLETED',
        'FAILED'
      ));
  `);

  // ── Drop column ───────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP COLUMN IF EXISTS response_analysis_result;
  `);
};