// backend/src/utils/istTime.js
'use strict';

const { toZonedTime, fromZonedTime, format } = require('date-fns-tz');
const { isWeekend, parseISO }                = require('date-fns');

const IST_TIMEZONE = 'Asia/Kolkata';

// ── Get current date/time in IST ──────────────────────────────────
// Returns a Date object representing right now in IST.
// Use this everywhere you need "now" in the application.
function nowIST() {
  return toZonedTime(new Date(), IST_TIMEZONE);
}

// ── Get today's date string in IST ───────────────────────────────
// Returns 'YYYY-MM-DD' string for today in IST.
// This is what goes into batch.target_date.
function todayIST() {
  return format(toZonedTime(new Date(), IST_TIMEZONE), 'yyyy-MM-dd', {
    timeZone: IST_TIMEZONE,
  });
}

// ── Format a date as IST timestamp string ────────────────────────
// Used in email templates and log messages.
// Returns human-readable: "09 Mar 2026, 10:02 AM IST"
function formatISTTimestamp(date) {
  const zoned = date instanceof Date
    ? toZonedTime(date, IST_TIMEZONE)
    : toZonedTime(new Date(date), IST_TIMEZONE);

  return format(zoned, "dd MMM yyyy, hh:mm a 'IST'", {
    timeZone: IST_TIMEZONE,
  });
}

// ── Format a date for filenames (DDMMYYYY) ───────────────────────
// Used when building the download filename in the presigned URL.
// The download date is always the current IST date — not the
// batch target_date. Re-downloads always use the latest date.
function formatDateForFilename(date) {
  const zoned = date instanceof Date
    ? toZonedTime(date, IST_TIMEZONE)
    : toZonedTime(new Date(date), IST_TIMEZONE);

  return format(zoned, 'ddMMyyyy', { timeZone: IST_TIMEZONE });
}

// ── Parse a 'DD-MM-YYYY' string to a Date ────────────────────────
// Used when reading dates from R2 path strings or filenames.
function parseDDMMYYYY(str) {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    throw new Error(`istTime: Cannot parse "${str}" — expected DD-MM-YYYY format`);
  }
  const [day, month, year] = str.split('-');
  // parseISO expects YYYY-MM-DD
  return parseISO(`${year}-${month}-${day}`);
}

// ── Check if a date is a working day (Mon–Sat) ───────────────────
// The CRON fires Mon–Sat only. Sunday is excluded.
// Used by the manual trigger to warn ops about weekend dates.
function isWorkingDay(dateStr) {
  // parseISO handles 'YYYY-MM-DD' strings
  const date = typeof dateStr === 'string' ? parseISO(dateStr) : dateStr;
  // isWeekend returns true for Saturday AND Sunday in date-fns
  // We only exclude Sunday (day 0), Saturday (day 6) is a working day
  return date.getDay() !== 0; // 0 = Sunday
}

// ── Check if a date is in the future (IST) ───────────────────────
// Used by the manual trigger to reject future dates.
function isFutureDate(dateStr) {
  const today = todayIST();
  return dateStr > today; // string comparison works for YYYY-MM-DD
}

// ── Generate all working dates in a range ────────────────────────
// Used by the manual batch generation endpoint.
// Returns array of 'YYYY-MM-DD' strings, Sundays excluded.
function getWorkingDatesInRange(startDateStr, endDateStr) {
  const dates = [];
  let current = parseISO(startDateStr);
  const end   = parseISO(endDateStr);

  while (current <= end) {
    const str = format(current, 'yyyy-MM-dd');
    if (isWorkingDay(str)) {
      dates.push(str);
    }
    // Move to next day
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }

  return dates;
}

module.exports = {
  nowIST,
  todayIST,
  formatISTTimestamp,
  formatDateForFilename,
  parseDDMMYYYY,
  isWorkingDay,
  isFutureDate,
  getWorkingDatesInRange,
  IST_TIMEZONE,
};