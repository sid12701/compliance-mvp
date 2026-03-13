// backend/src/utils/r2Paths.js
'use strict';

function formatDateForPath(date) {
  let d;

  if (date instanceof Date) {
    const day   = String(date.getUTCDate()).padStart(2, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const year  = date.getUTCFullYear();
    return `${day}-${month}-${year}`;
  }

  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [year, month, day] = date.split('-');
      return `${day}-${month}-${year}`;
    }
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
      return date;
    }
  }

  throw new Error(
    `r2Paths: Cannot format date "${date}". ` +
    `Expected a Date object, 'YYYY-MM-DD', or 'DD-MM-YYYY' string.`
  );
}

const r2Paths = {

  searchFile(targetDate, filename) {
    return `ckyc/${formatDateForPath(targetDate)}/search/${filename}`;
  },

  responseFile(targetDate, filename) {
    return `ckyc/${formatDateForPath(targetDate)}/response/${filename}`;
  },

  downloadFile(targetDate, filename) {
    return `ckyc/${formatDateForPath(targetDate)}/download/${filename}`;
  },

  uploadFile(targetDate, filename) {
    return `ckyc/${formatDateForPath(targetDate)}/upload/${filename}`;
  },

  // ← NEW: returns the upload folder prefix for standalone generation
  uploadDir(targetDate) {
    return `ckyc/${formatDateForPath(targetDate)}/upload/`;
  },

  prefix(targetDate, type) {
    const validTypes = ['search', 'response', 'download', 'upload'];
    if (!validTypes.includes(type)) {
      throw new Error(`r2Paths.prefix: invalid type "${type}"`);
    }
    return `ckyc/${formatDateForPath(targetDate)}/${type}/`;
  },
};

function validateKey(key) {
  if (!key || typeof key !== 'string') {
    throw new Error(`r2Paths: Key must be a non-empty string, got: ${key}`);
  }
  if (!key.startsWith('ckyc/')) {
    throw new Error(`r2Paths: Key must start with 'ckyc/', got: "${key}"`);
  }
  if (key.includes('undefined') || key.includes('null')) {
    throw new Error(`r2Paths: Key contains 'undefined' or 'null': "${key}"`);
  }
  return true;
}

module.exports = { r2Paths, formatDateForPath, validateKey };