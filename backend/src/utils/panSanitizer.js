// backend/src/utils/panSanitizer.js
'use strict';

// ── PAN pattern ───────────────────────────────────────────────────
// Indian Permanent Account Number format:
// 5 uppercase letters + 4 digits + 1 uppercase letter
// Example: ABCDE1234F
//
// The 'g' flag replaces ALL occurrences in a string, not just the first.
const PAN_REGEX = /[A-Z]{5}[0-9]{4}[A-Z]/g;

const REDACTED = '[PAN_REDACTED]';

// ── String sanitizer ──────────────────────────────────────────────
// Replaces all PAN patterns in a string with [PAN_REDACTED].
// Safe to call on null/undefined — returns the input unchanged.
// Truncates to maxLength after redaction (default 500 per PRD).
function sanitizePAN(str, maxLength = 500) {
  if (typeof str !== 'string') return str;
  return str.replace(PAN_REGEX, REDACTED).substring(0, maxLength);
}

// ── Stderr sanitizer ──────────────────────────────────────────────
// Specific helper for Python process stderr output.
// Always truncates to 500 chars per PRD requirement NFR-SEC-3.
// Applied unconditionally on both success and failure exits.
function sanitizeStderr(stderrBuffer) {
  if (!stderrBuffer) return '';
  const raw = Buffer.isBuffer(stderrBuffer)
    ? stderrBuffer.toString('utf8')
    : String(stderrBuffer);
  return sanitizePAN(raw, 500);
}

// ── Object sanitizer ─────────────────────────────────────────────
// Recursively walks an object and sanitizes all string values.
// Used when logging structured error objects from Python crashes.
// Does not mutate the original — returns a new sanitized object.
function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizePAN(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value);
    }
    return sanitized;
  }

  // Numbers, booleans, etc. — return as-is
  return obj;
}

// ── Validation helper ─────────────────────────────────────────────
// Checks whether a string contains any PAN-like pattern.
// Used before logging to decide if extra caution is needed.
function containsPAN(str) {
  if (typeof str !== 'string') return false;
  PAN_REGEX.lastIndex = 0; // Reset stateful regex
  return PAN_REGEX.test(str);
}

module.exports = { sanitizePAN, sanitizeStderr, sanitizeObject, containsPAN };