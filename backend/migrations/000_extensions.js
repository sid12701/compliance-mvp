// backend/migrations/000_extensions.js
'use strict';

// Must run first.
// pgcrypto provides gen_random_uuid() used as the default
// primary key on every table in this schema.

exports.up = async function (knex) {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
};

exports.down = async function (knex) {
  // We do not drop pgcrypto on rollback.
  // Other databases on the same  instance may use it.
  // Dropping it would be destructive beyond our schema.
};