// backend/src/utils/filenameValidator.js
'use strict';

const { AppError }    = require('../constants/errorCodes');
const { ERROR_CODES } = require('../constants/errorCodes');

// ── Authoritative regex (PRD Section 6.2) ────────────────────────
// IMPORTANT: Use this regex verbatim. Case-sensitive. ^ and $ mandatory.
// Capture groups:
//   1 = DD   (day, 2 digits)
//   2 = MM   (month, 2 digits)
//   3 = YYYY (year, 4 digits)
//   4 = SSSSS (sequence, 5 digits)
const RESPONSE_FILENAME_REGEX = /^IN3860_(\d{2})(\d{2})(\d{4})_V1\.1_S(\d{5})_Res\.txt$/;
const SEARCH_FILENAME_REGEX   = /^IN3860_(\d{2})(\d{2})(\d{4})_V1\.1_S(\d{5})\.txt$/;

// ── Step 2 helper: real calendar date check ───────────────────────
// JavaScript's Date constructor is permissive — new Date(2026, 1, 31)
// silently rolls over to March 3rd instead of throwing.
// We detect rollover by checking the constructed date's parts
// match what we put in.
function isRealCalendarDate(day, month, year) {
  // JS months are 0-indexed: January = 0, February = 1
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year  &&
    d.getMonth()    === month - 1 &&
    d.getDate()     === day
  );
}

// ── Main validator ────────────────────────────────────────────────
// Validates a Response filename against the 4-step sequence.
//
// Parameters:
//   filename      — the filename to validate (string)
//   batch         — the batch object from DB, must have:
//                   { batch_sequence: number, target_date: string 'YYYY-MM-DD' }
//
// Returns: { valid: true, parsedDate: 'DD-MM-YYYY', sequence: number }
// Throws:  AppError with code INVALID_FILENAME and details about which
//          step failed and what was expected vs received.

function _extractDateFromSearchKey(searchFileKey) {
  if (!searchFileKey) return null;
  const base = String(searchFileKey).split('/').pop();
  const match = SEARCH_FILENAME_REGEX.exec(base || '');
  if (!match) return null;
  return {
    day:   parseInt(match[1], 10),
    month: parseInt(match[2], 10),
    year:  parseInt(match[3], 10),
  };
}

function _normalizeExpectedDate(expectedDateStr) {
  if (!expectedDateStr || typeof expectedDateStr !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expectedDateStr)) {
    const [year, month, day] = expectedDateStr.split('-').map(Number);
    return { day, month, year };
  }
  if (/^\d{2}-\d{2}-\d{4}$/.test(expectedDateStr)) {
    const [day, month, year] = expectedDateStr.split('-').map(Number);
    return { day, month, year };
  }
  return null;
}

function validateResponseFilename(filename, batch) {

  // ── Step 1: Regex match ─────────────────────────────────────
  // Catches all structural errors in one shot.
  const match = RESPONSE_FILENAME_REGEX.exec(filename);

  if (!match) {
    throw new AppError(
      `Filename "${filename}" does not match the required CKYC format.`,
      422,
      ERROR_CODES.INVALID_FILENAME,
      {
        failed_check: 'regex_match',
        expected_format: 'IN3860_{DDMMYYYY}_V1.1_S{SSSSS}_Res.txt',
        received: filename,
        hint: 'Check institution code (IN3860), version (V1.1), case sensitivity, and extension (.txt)',
      }
    );
  }

  // Extract captured groups
  const day      = parseInt(match[1], 10);
  const month    = parseInt(match[2], 10);
  const year     = parseInt(match[3], 10);
  const sequence = parseInt(match[4], 10);

  // ── Step 2: Real calendar date ──────────────────────────────
  if (!isRealCalendarDate(day, month, year)) {
    throw new AppError(
      `Filename contains an invalid calendar date: ${match[1]}-${match[2]}-${match[3]}.`,
      422,
      ERROR_CODES.INVALID_FILENAME,
      {
        failed_check: 'date_not_real_calendar_date',
        day, month, year,
        hint: `${match[1]}/${match[2]}/${match[3]} is not a real date`,
      }
    );
  }

  // ── Step 3: Sequence match ──────────────────────────────────
  // The filename's 5-digit sequence must match this batch's sequence.
  const expectedSequence = batch.batch_sequence;

  if (sequence !== expectedSequence) {
    throw new AppError(
      `Filename sequence S${String(sequence).padStart(5, '0')} does not match ` +
      `batch sequence S${String(expectedSequence).padStart(5, '0')}.`,
      422,
      ERROR_CODES.INVALID_FILENAME,
      {
        failed_check:      'sequence_mismatch',
        expected:          String(expectedSequence).padStart(5, '0'),
        received:          String(sequence).padStart(5, '0'),
        hint:              'You may have selected the wrong Response file for this batch',
      }
    );
  }

  // ── Step 4: Date cross-check ────────────────────────────────
  // batch.target_date from PostgreSQL is 'YYYY-MM-DD'
  // Filename date is DD/MM/YYYY from the capture groups
  // We need to compare them as the same date.
  const expectedFromSearch = _extractDateFromSearchKey(batch.search_file_key);
  const expectedFromTarget = _normalizeExpectedDate(batch.target_date);
  const expected = expectedFromSearch || expectedFromTarget;

  if (!expected) {
    throw new AppError(
      'Unable to determine expected date for response filename validation.',
      422,
      ERROR_CODES.INVALID_FILENAME,
      { failed_check: 'missing_expected_date' }
    );
  }

  if (day !== expected.day || month !== expected.month || year !== expected.year) {
    // Format dates for human-readable error message
    const filenameDate = `${match[1]}-${match[2]}-${match[3]}`;
    const expectedDate = `${String(expected.day).padStart(2,'0')}-${String(expected.month).padStart(2,'0')}-${expected.year}`;

    throw new AppError(
      `Filename date ${filenameDate} does not match expected date ${expectedDate}.`,
      422,
      ERROR_CODES.INVALID_FILENAME,
      {
        failed_check:   'date_mismatch',
        filename_date:  filenameDate,
        expected_date:  expectedDate,
        hint:           'This Response file belongs to a different search file date',
      }
    );
  }

  // ── All 4 steps passed ───────────────────────────────────────
  return {
    valid:       true,
    parsedDate:  `${match[1]}-${match[2]}-${match[3]}`,  // DD-MM-YYYY
    sequence,
  };
}

module.exports = { validateResponseFilename };
