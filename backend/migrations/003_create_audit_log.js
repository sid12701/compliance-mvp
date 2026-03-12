'use strict';

exports.up = async function (knex) {
  // ── audit_log table ───────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE audit_log (
      id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
      action     VARCHAR(50) NOT NULL,
      batch_id   UUID        REFERENCES ckyc_batches(id) ON DELETE SET NULL,
      ip_address INET,
      metadata   JSONB       NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT chk_audit_action CHECK (action IN (
        'LOGIN',
        'LOGIN_FAILED',
        'LOGOUT',
        'BATCH_ACCESSED',
        'MANUAL_GENERATION_TRIGGERED',
        'BATCH_GENERATED',
        'SEARCH_FILE_URL_REQUESTED',
        'SEARCH_FILE_DOWNLOADED',
        'CKYC_UPLOAD_CONFIRMED',
        'RESPONSE_UPLOAD_INITIATED',
        'RESPONSE_FILE_UPLOADED',
        'RESPONSE_PROCESSED',
        'FINAL_FILE_DOWNLOADED',
        'BATCH_FAILED'
      ))
    );
  `);

  // ── Append-only enforcement ───────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only. Updates and deletes are prohibited.';
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    CREATE TRIGGER audit_log_immutable
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_mutation();
  `);

  // ── Indexes ───────────────────────────────────────────────────

  // Compliance query: all actions by a specific user over time
  await knex.raw(`
    CREATE INDEX idx_audit_log_user_date
      ON audit_log (user_id, created_at DESC);
  `);

  // Compliance query: full audit trail for a specific batch
  await knex.raw(`
    CREATE INDEX idx_audit_log_batch_date
      ON audit_log (batch_id, created_at DESC);
  `);

  // Compliance query: all occurrences of a specific action type
  await knex.raw(`
    CREATE INDEX idx_audit_log_action_date
      ON audit_log (action, created_at DESC);
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;`);
  await knex.raw(`DROP FUNCTION IF EXISTS prevent_audit_log_mutation;`);
  await knex.raw(`DROP TABLE IF EXISTS audit_log;`);
};
