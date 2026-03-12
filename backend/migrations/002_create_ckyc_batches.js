'use strict';

exports.up = async function (knex) {
  // ── ckyc_batches table ────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE ckyc_batches (
      id                       UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      target_date              DATE         NOT NULL,
      batch_sequence           INT          NOT NULL,
      status                   VARCHAR(30)  NOT NULL DEFAULT 'PROCESSING',
      search_file_key          VARCHAR(500),
      response_file_key        VARCHAR(500),
      download_file_key        VARCHAR(500),
      upload_file_key          VARCHAR(500),
      response_analysis_result JSONB,
      is_uploaded_ckyc         BOOLEAN      NOT NULL DEFAULT FALSE,
      last_downloaded_at       TIMESTAMPTZ,
      created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
      error_message            TEXT,
      is_purged                BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

      CONSTRAINT uq_batch_date_seq
        UNIQUE (target_date, batch_sequence),

      CONSTRAINT chk_ckyc_batch_status CHECK (status IN (
        'PROCESSING',
        'GENERATED',
        'DOWNLOADED',
        'WAITING_RESPONSE',
        'PROCESSING_RESPONSE',
        'COMPLETED',
        'FAILED'
      ))
    );
  `);

  // ── updated_at trigger ────────────────────────────────────────
  // Reuses set_updated_at() function created in migration 001.
  await knex.raw(`
    CREATE TRIGGER batches_updated_at
      BEFORE UPDATE ON ckyc_batches
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);

  // ── Indexes ───────────────────────────────────────────────────

  // Dashboard list: ORDER BY target_date DESC
  await knex.raw(`
    CREATE INDEX idx_batches_target_date
      ON ckyc_batches (target_date DESC);
  `);

  // Status filter on dashboard
  await knex.raw(`
    CREATE INDEX idx_batches_status
      ON ckyc_batches (status);
  `);

  // Combined date + status filter
  await knex.raw(`
    CREATE INDEX idx_batches_date_status
      ON ckyc_batches (target_date DESC, status);
  `);

  // Partial index: idempotency guard query pattern
  // SELECT * FROM ckyc_batches WHERE target_date = $1 AND status != 'FAILED'
  // Only indexes non-FAILED rows — smaller and faster than a full index
  await knex.raw(`
    CREATE INDEX idx_batches_date_non_failed
      ON ckyc_batches (target_date)
      WHERE status != 'FAILED';
  `);

  // Partial index: dashboard list always excludes purged records
  // Only indexes non-purged rows — the 99.9% case
  await knex.raw(`
    CREATE INDEX idx_batches_not_purged
      ON ckyc_batches (target_date DESC)
      WHERE is_purged = FALSE;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS batches_updated_at ON ckyc_batches;`);
  await knex.raw(`DROP TABLE IF EXISTS ckyc_batches;`);
};
