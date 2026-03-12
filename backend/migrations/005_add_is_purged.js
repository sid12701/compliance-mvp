'use strict';

// Adds soft-delete flag for 7-year CKYC data retention policy.
// Batches past the retention window are marked is_purged = TRUE.
// Records are never hard-deleted during the retention window.

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD COLUMN IF NOT EXISTS is_purged BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_batches_not_purged
      ON ckyc_batches (target_date DESC)
      WHERE is_purged = FALSE;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_batches_not_purged;`);

  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP COLUMN IF EXISTS is_purged;
  `);
};
