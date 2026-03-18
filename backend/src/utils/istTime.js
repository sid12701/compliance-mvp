// backend/src/utils/istTime.js
'use strict';

const { toZonedTime, fromZonedTime, format } = require('date-fns-tz');
const { isWeekend, parseISO }                = require('date-fns');

const IST_TIMEZONE = 'Asia/Kolkata';

function nowIST() {
  return toZonedTime(new Date(), IST_TIMEZONE);
}

function todayIST() {
  return format(toZonedTime(new Date(), IST_TIMEZONE), 'yyyy-MM-dd', {
    timeZone: IST_TIMEZONE,
  });
}

function formatISTTimestamp(date) {
  const zoned = date instanceof Date
    ? toZonedTime(date, IST_TIMEZONE)
    : toZonedTime(new Date(date), IST_TIMEZONE);

  return format(zoned, "dd MMM yyyy, hh:mm a 'IST'", {
    timeZone: IST_TIMEZONE,
  });
}

function formatDateForFilename(date) {
  const zoned = date instanceof Date
    ? toZonedTime(date, IST_TIMEZONE)
    : toZonedTime(new Date(date), IST_TIMEZONE);

  return format(zoned, 'ddMMyyyy', { timeZone: IST_TIMEZONE });
}

function parseDDMMYYYY(str) {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    throw new Error(`istTime: Cannot parse "${str}" — expected DD-MM-YYYY format`);
  }
  const [day, month, year] = str.split('-');
  return parseISO(`${year}-${month}-${day}`);
}

// ── All days are working days ─────────────────────────────────────
// Batches run 7 days a week — no day exclusions.
function isWorkingDay(dateStr) {
  return true;
}

function isFutureDate(dateStr) {
  const today = todayIST();
  return dateStr > today;
}

// ── Generate all dates in a range (all 7 days) ───────────────────
function getWorkingDatesInRange(startDateStr, endDateStr) {
  const dates = [];
  let current = parseISO(startDateStr);
  const end   = parseISO(endDateStr);

  while (current <= end) {
    dates.push(format(current, 'yyyy-MM-dd'));
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