'use strict';

exports.up = async function (knex) {
  // ── token_blacklist table ─────────────────────────────────────
  await knex.raw(`
    CREATE TABLE token_blacklist (
      jti        UUID        NOT NULL PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  // ── Index for cleanup job ─────────────────────────────────────
  // DELETE FROM token_blacklist WHERE expires_at < NOW()
  // runs periodically to prevent unbounded table growth.
  await knex.raw(`
    CREATE INDEX idx_token_blacklist_expires
      ON token_blacklist (expires_at);
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS token_blacklist;`);
};
