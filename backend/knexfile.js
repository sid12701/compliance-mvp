'use strict';

require('dotenv').config();

// Knex only needs DATABASE_URL — it manages its own connection.
// All other app config lives in src/config/env.js and is used
// by the running application, not by the migration runner.

const databaseUrl = process.env.DATABASE_URL;
const useSsl = !/sslmode=disable/i.test(databaseUrl || '') &&
  (process.env.DB_SSL || 'true').toLowerCase() !== 'false';

module.exports = {
  client: 'pg',

  connection: useSsl
    ? {
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false }, // Required for Supabase/hosted Postgres
      }
    : databaseUrl,

  migrations: {
    directory: './migrations',   // Where migration files live
    tableName: 'knex_migrations', // Table Knex creates to track what has run
    extension: 'js',
  },
};
