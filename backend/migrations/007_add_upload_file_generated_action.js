// backend/src/db/migrations/007_add_upload_file_generated_action.js
'use strict';

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE audit_log
      DROP CONSTRAINT IF EXISTS audit_log_action_check;

    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_action_check CHECK (action IN (
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
        'UPLOAD_FILE_GENERATED',
        'BATCH_FAILED'
      ));
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE audit_log
      DROP CONSTRAINT IF EXISTS audit_log_action_check;

    ALTER TABLE audit_log
      ADD CONSTRAINT audit_log_action_check CHECK (action IN (
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
      ));
  `);
};