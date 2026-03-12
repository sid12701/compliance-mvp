'use strict';

require('dotenv').config();

// Knex only needs DATABASE_URL — it manages its own connection.
// All other app config lives in src/config/env.js and is used
// by the running application, not by the migration runner.

module.exports = {
  client: 'pg',

  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for Supabase/hosted Postgres
  },

  migrations: {
    directory: './migrations',   // Where migration files live
    tableName: 'knex_migrations', // Table Knex creates to track what has run
    extension: 'js',
  },
};
