'use strict';

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE ckyc_batches
      ADD COLUMN IF NOT EXISTS pan_dob_r2_key TEXT;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE ckyc_batches
      DROP COLUMN IF EXISTS pan_dob_r2_key;
  `);
};