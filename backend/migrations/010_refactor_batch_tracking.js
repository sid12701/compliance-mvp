'use strict';

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD COLUMN IF NOT EXISTS primary_ops_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS secondary_ops_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS current_assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS search_uploaded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS search_uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS final_upload_uploaded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS final_upload_uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS timeline JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  await knex.raw(`
    UPDATE ckyc_batches
    SET timeline = COALESCE(agg.events, '[]'::jsonb)
    FROM (
      SELECT
        al.batch_id,
        jsonb_agg(
          jsonb_build_object(
            'type', lower(al.action),
            'at', al.created_at,
            'user_id', al.user_id,
            'username', u.username,
            'metadata', al.metadata
          )
          ORDER BY al.created_at ASC, al.id ASC
        ) AS events
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.batch_id IS NOT NULL
      GROUP BY al.batch_id
    ) AS agg
    WHERE ckyc_batches.id = agg.batch_id;
  `);

  await knex.raw(`
    UPDATE ckyc_batches
    SET status = 'FINAL_FILES_READY'
    WHERE status = 'COMPLETED';
  `);

  await knex.raw(`
    UPDATE ckyc_batches
    SET
      search_uploaded_at = COALESCE(search_uploaded_at, updated_at, created_at),
      search_uploaded_by = COALESCE(search_uploaded_by, created_by)
    WHERE is_uploaded_ckyc = TRUE;
  `);

  await knex.raw(`
    UPDATE ckyc_batches
    SET
      primary_ops_user_id = COALESCE(primary_ops_user_id, created_by),
      current_assignee_user_id = COALESCE(current_assignee_user_id, created_by)
    WHERE created_by IS NOT NULL;
  `);

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
        'FINAL_FILES_READY',
        'COMPLETED',
        'FAILED'
      ));
  `);

  await knex.raw(`DROP INDEX IF EXISTS idx_batches_not_purged;`);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP COLUMN IF EXISTS is_uploaded_ckyc,
      DROP COLUMN IF EXISTS is_purged;
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;`);
  await knex.raw(`DROP FUNCTION IF EXISTS prevent_audit_log_mutation;`);
  await knex.raw(`DROP TABLE IF EXISTS audit_log;`);
};

exports.down = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
      action     VARCHAR(50) NOT NULL,
      batch_id   UUID        REFERENCES ckyc_batches(id) ON DELETE SET NULL,
      ip_address INET,
      metadata   JSONB       NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD COLUMN IF NOT EXISTS is_uploaded_ckyc BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_purged BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await knex.raw(`
    UPDATE ckyc_batches
    SET is_uploaded_ckyc = (search_uploaded_at IS NOT NULL);
  `);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP CONSTRAINT IF EXISTS chk_ckyc_batch_status;
  `);

  await knex.raw(`
    UPDATE ckyc_batches
    SET status = 'COMPLETED'
    WHERE status = 'FINAL_FILES_READY';
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

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_batches_not_purged
      ON ckyc_batches (target_date DESC)
      WHERE is_purged = FALSE;
  `);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP COLUMN IF EXISTS primary_ops_user_id,
      DROP COLUMN IF EXISTS secondary_ops_user_id,
      DROP COLUMN IF EXISTS current_assignee_user_id,
      DROP COLUMN IF EXISTS search_uploaded_at,
      DROP COLUMN IF EXISTS search_uploaded_by,
      DROP COLUMN IF EXISTS final_upload_uploaded_at,
      DROP COLUMN IF EXISTS final_upload_uploaded_by,
      DROP COLUMN IF EXISTS timeline;
  `);
};
