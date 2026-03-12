'use strict';

exports.up = async function (knex) {
  // ── Users table ──────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE users (
      id             UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      username       VARCHAR(100) NOT NULL UNIQUE,
      password_hash  VARCHAR(255) NOT NULL,
      role           VARCHAR(50)  NOT NULL DEFAULT 'operator',
      is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
      last_login_at  TIMESTAMPTZ,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  // ── Shared updated_at trigger function ───────────────────────
  // CREATE OR REPLACE so re-running this migration is safe.
  // This function is also used by the ckyc_batches trigger (migration 002).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // ── Attach trigger to users ───────────────────────────────────
  await knex.raw(`
    CREATE TRIGGER users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = async function (knex) {
  // Drop in reverse dependency order
  await knex.raw(`DROP TRIGGER IF EXISTS users_updated_at ON users;`);
  await knex.raw(`DROP FUNCTION IF EXISTS set_updated_at;`);
  await knex.raw(`DROP TABLE IF EXISTS users;`);
};
