'use strict';

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE file_sequences (
      seq_date  DATE         NOT NULL,
      file_type VARCHAR(20)  NOT NULL,
      last_seq  INTEGER      NOT NULL DEFAULT 0,
      PRIMARY KEY (seq_date, file_type)
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS file_sequences;`);
};