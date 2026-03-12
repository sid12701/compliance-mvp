// backend/src/services/batch.service.js
'use strict';

const { pool }                        = require('../config/database');
const { AppError, ERROR_CODES }       = require('../constants/errorCodes');
const { BATCH_STATUS,
        assertValidTransition,
        SEARCH_DOWNLOAD_ELIGIBLE }    = require('../constants/batchStatus');
const { AUDIT_ACTIONS }               = require('../constants/auditActions');
const { r2Paths }                     = require('../utils/r2Paths');
const { validateResponseFilename }    = require('../utils/filenameValidator');
const { formatDateForFilename,
        todayIST,
        isFutureDate,
        getWorkingDatesInRange }      = require('../utils/istTime');
const r2Service                       = require('./r2.service');
const { enqueueSearchGeneration,
        enqueueResponseAnalysis }     = require('../workers/queue');

// ════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════════════════

// Fetch batch or throw structured error
// Handles both 404 (not found) and 410 (purged) in one place
async function _getBatchOrThrow(batchId) {
  const result = await pool.query(
    `SELECT * FROM ckyc_batches WHERE id = $1`,
    [batchId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `Batch with ID ${batchId} was not found.`,
      404,
      ERROR_CODES.BATCH_NOT_FOUND
    );
  }

  const batch = result.rows[0];

  if (batch.is_purged) {
    throw new AppError(
      "This batch's files have been purged per the 7-year retention policy.",
      410,
      ERROR_CODES.BATCH_PURGED
    );
  }

  return batch;
}

// Assert batch is in one of the expected statuses
// Used to check preconditions before an operation
function _assertStatus(batch, ...allowedStatuses) {
  if (!allowedStatuses.includes(batch.status)) {
    throw new AppError(
      `This action requires the batch to be in [${allowedStatuses.join(' or ')}] status. ` +
      `Current status: "${batch.status}".`,
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }
}

// Build the R2 key for the search file
// Uses target_date for the path — this key never changes
function _buildSearchFileKey(batch) {
  const seq      = String(batch.batch_sequence).padStart(5, '0');
  const dateStr  = formatDateForFilename(batch.target_date); // DDMMYYYY from target_date
  const filename = `IN3860_${dateStr}_V1.1_S${seq}.txt`;
  return r2Paths.searchFile(batch.target_date, filename);
}

// Build the download filename for the Content-Disposition header
// Uses TODAY's IST date — not the target_date (PRD requirement)
// Re-downloads always show the latest download date
function _buildSearchDownloadFilename(batch) {
  const seq      = String(batch.batch_sequence).padStart(5, '0');
  const todayStr = formatDateForFilename(new Date()); // DDMMYYYY from today IST
  return `IN3860_${todayStr}_V1.1_S${seq}.txt`;
}

// Get the next available batch sequence number
async function _getNextBatchSequence() {
  const result = await pool.query(
    `SELECT COALESCE(MAX(batch_sequence), 0) + 1 AS next_seq FROM ckyc_batches`
  );
  return parseInt(result.rows[0].next_seq, 10);
}

// Audit log helper
// Phase 6 replaces this with the shared audit.service.js
// client parameter allows writing inside an existing transaction
async function _insertAuditLog({ userId, action, batchId, ipAddress, metadata }, client) {
  try {
    await (client || pool).query(
      `INSERT INTO audit_log (user_id, action, batch_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId    || null,
        action,
        batchId   || null,
        ipAddress || null,
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (auditErr) {
    // Audit failure must NEVER block the primary operation
    // Log as ERROR for manual reconciliation
    console.error(
      `[Audit] INSERT failed for action "${action}":`,
      auditErr.message
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC SERVICE FUNCTIONS
// ════════════════════════════════════════════════════════════════════

// ── GET /batches ──────────────────────────────────────────────────
async function listBatches({ startDate, endDate, status, page = 1, limit = 20 }) {
  const safeLimit  = Math.min(parseInt(limit, 10)  || 20, 100);
  const safePage   = Math.max(parseInt(page, 10)   || 1,  1);
  const offset     = (safePage - 1) * safeLimit;

  // Default to last 30 days if no date range provided
  const from = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  const to   = endDate || todayIST();

  const filterParams = [from, to, status || null];

  const [batchesResult, countResult] = await Promise.all([
    pool.query(
      `SELECT
         id, target_date, batch_sequence, status,
         is_uploaded_ckyc, last_downloaded_at,
         created_by, error_message,
         search_file_key   IS NOT NULL AS has_search_file,
         response_file_key IS NOT NULL AS has_response_file,
         download_file_key IS NOT NULL AS has_download_file,
         upload_file_key   IS NOT NULL AS has_upload_file,
         created_at, updated_at
       FROM ckyc_batches
       WHERE is_purged   = FALSE
         AND target_date >= $1::date
         AND target_date <= $2::date
         AND ($3::text IS NULL OR status = $3)
       ORDER BY target_date DESC
       LIMIT $4 OFFSET $5`,
      [...filterParams, safeLimit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM ckyc_batches
       WHERE is_purged   = FALSE
         AND target_date >= $1::date
         AND target_date <= $2::date
         AND ($3::text IS NULL OR status = $3)`,
      filterParams
    ),
  ]);

  const total      = parseInt(countResult.rows[0].total, 10);
  const totalPages = Math.ceil(total / safeLimit);

  return {
    batches:    batchesResult.rows,
    pagination: {
      page:        safePage,
      limit:       safeLimit,
      total_count: total,
      total_pages: totalPages,
    },
  };
}

// ── GET /batches/:id ──────────────────────────────────────────────
async function getBatchById({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.BATCH_ACCESSED,
    batchId:   batch.id,
    ipAddress,
    metadata:  { target_date: batch.target_date, batch_status: batch.status },
  });

  return batch;
}

// ── POST /internal/trigger-daily-batch ───────────────────────────
// Called by the CRON webhook controller.
// Returns { skipped: true } if batch already exists for this date.
// Returns { created: true, batch } if new batch was created.
async function triggerDailyBatch({ targetDate, requestId }) {

  // Idempotency check: does a non-FAILED batch already exist for today?
  const existing = await pool.query(
    `SELECT id, status, batch_sequence
     FROM ckyc_batches
     WHERE target_date = $1 AND status != 'FAILED'`,
    [targetDate]
  );

  if (existing.rows.length > 0) {
    return { skipped: true, batch: existing.rows[0] };
  }

  // Check for a FAILED batch to update in-place (re-trigger scenario)
  const failed = await pool.query(
    `SELECT * FROM ckyc_batches
     WHERE target_date = $1 AND status = 'FAILED'
     ORDER BY created_at DESC LIMIT 1`,
    [targetDate]
  );

  let batch;

  if (failed.rows.length > 0) {
    // Update FAILED batch in-place — never create a duplicate row
    const result = await pool.query(
      `UPDATE ckyc_batches
       SET status = 'PROCESSING', error_message = NULL
       WHERE id = $1
       RETURNING *`,
      [failed.rows[0].id]
    );
    batch = result.rows[0];
  } else {
    // No existing batch — create a fresh one
    const batchSequence = await _getNextBatchSequence();
    const result        = await pool.query(
      `INSERT INTO ckyc_batches (target_date, batch_sequence, status, created_by)
       VALUES ($1, $2, 'PROCESSING', NULL)
       RETURNING *`,
      [targetDate, batchSequence]
    );
    batch = result.rows[0];
  }

  // Build R2 key and enqueue search generation job
  const r2OutputKey = _buildSearchFileKey(batch);

  await enqueueSearchGeneration({
    batchId:       batch.id,
    targetDate,
    batchSequence: batch.batch_sequence,
    r2OutputKey,
    requestId,
  });

  return { created: true, batch };
}

// ── POST /batches/generate ────────────────────────────────────────
// Manual date range trigger — same pipeline as CRON but for multiple dates
async function generateBatches({ startDate, endDate, userId, ipAddress, requestId }) {

  // Validate: no future dates
  if (isFutureDate(startDate)) {
    throw new AppError(
      'start_date cannot be in the future.',
      400,
      ERROR_CODES.INVALID_REQUEST,
      { start_date: startDate }
    );
  }

  if (isFutureDate(endDate)) {
    throw new AppError(
      'end_date cannot be in the future.',
      400,
      ERROR_CODES.INVALID_REQUEST,
      { end_date: endDate }
    );
  }

  if (startDate > endDate) {
    throw new AppError(
      'start_date must be before or equal to end_date.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  // Get all working dates (Mon–Sat) in the range
  const dates = getWorkingDatesInRange(startDate, endDate);

  if (dates.length === 0) {
    throw new AppError(
      'No working days found in the selected date range. Sundays are excluded.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  // Log the intent before enqueuing any jobs
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.MANUAL_GENERATION_TRIGGERED,
    batchId:   null,
    ipAddress,
    metadata: {
      date_range_start: startDate,
      date_range_end:   endDate,
      dates_requested:  dates.length,
    },
  });

  const datesQueued            = [];
  const datesSkipped           = [];
  const datesFailedRetriggered = [];

  for (const date of dates) {
    // Check for existing non-FAILED batch → skip
    const existing = await pool.query(
      `SELECT id, status FROM ckyc_batches
       WHERE target_date = $1 AND status != 'FAILED'`,
      [date]
    );

    if (existing.rows.length > 0) {
      datesSkipped.push(date);
      continue;
    }

    // Check for FAILED batch → re-trigger in-place
    const failed = await pool.query(
      `SELECT * FROM ckyc_batches
       WHERE target_date = $1 AND status = 'FAILED'
       ORDER BY created_at DESC LIMIT 1`,
      [date]
    );

    let batch;

    if (failed.rows.length > 0) {
      const result = await pool.query(
        `UPDATE ckyc_batches
         SET status = 'PROCESSING', error_message = NULL, created_by = $2
         WHERE id = $1
         RETURNING *`,
        [failed.rows[0].id, userId]
      );
      batch = result.rows[0];
      datesFailedRetriggered.push(date);
    } else {
      const batchSequence = await _getNextBatchSequence();
      const result        = await pool.query(
        `INSERT INTO ckyc_batches (target_date, batch_sequence, status, created_by)
         VALUES ($1, $2, 'PROCESSING', $3)
         RETURNING *`,
        [date, batchSequence, userId]
      );
      batch = result.rows[0];
      datesQueued.push(date);
    }

    // Enqueue search generation job for this date
    await enqueueSearchGeneration({
      batchId:       batch.id,
      targetDate:    date,
      batchSequence: batch.batch_sequence,
      r2OutputKey:   _buildSearchFileKey(batch),
      requestId,
    });
  }

  const jobsEnqueued = datesQueued.length + datesFailedRetriggered.length;

  // Advisory message if more than 7 jobs enqueued (PRD FR-7.5)
  const advisory = jobsEnqueued > 7
    ? `${jobsEnqueued} jobs have been enqueued and will process sequentially. ` +
      `This may take ${Math.ceil(jobsEnqueued * 2)}–${Math.ceil(jobsEnqueued * 3)} minutes to complete.`
    : null;

  return {
    jobs_enqueued:            jobsEnqueued,
    dates_queued:             datesQueued,
    dates_skipped:            datesSkipped,
    dates_failed_retriggered: datesFailedRetriggered,
    advisory,
  };
}

// ── GET /batches/:id/search-url ───────────────────────────────────
async function getSearchDownloadUrl({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  // Must be GENERATED or DOWNLOADED
  _assertStatus(batch, ...SEARCH_DOWNLOAD_ELIGIBLE);

  if (!batch.search_file_key) {
    throw new AppError(
      'Search file is not yet available for this batch.',
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }

  // Log intent (requested)
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.SEARCH_FILE_URL_REQUESTED,
    batchId:   batch.id,
    ipAddress,
    metadata: {
      target_date:    batch.target_date,
      batch_sequence: batch.batch_sequence,
    },
  });

  // Download filename uses TODAY's IST date (not target_date)
  const downloadFilename = _buildSearchDownloadFilename(batch);

  // Generate presigned URL
  const { url, expiresAt } = await r2Service.getPresignedDownloadUrl(
    batch.search_file_key,
    downloadFilename
  );

  // DB update in a transaction
  // First download: GENERATED → DOWNLOADED
  // Re-downloads: stay DOWNLOADED, just update timestamp
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (batch.status === BATCH_STATUS.GENERATED) {
      assertValidTransition(batch.status, BATCH_STATUS.DOWNLOADED);
      await client.query(
        `UPDATE ckyc_batches
         SET status = 'DOWNLOADED', last_downloaded_at = NOW()
         WHERE id = $1`,
        [batch.id]
      );
    } else {
      // Already DOWNLOADED — only update timestamp
      await client.query(
        `UPDATE ckyc_batches SET last_downloaded_at = NOW() WHERE id = $1`,
        [batch.id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Log outcome (downloaded)
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.SEARCH_FILE_DOWNLOADED,
    batchId:   batch.id,
    ipAddress,
    metadata: {
      target_date:    batch.target_date,
      batch_sequence: batch.batch_sequence,
      url_expires_at: expiresAt,
    },
  });

  return { url, filename: downloadFilename, expires_at: expiresAt };
}

// ── POST /batches/:id/confirm-upload ─────────────────────────────
// DOWNLOADED → WAITING_RESPONSE + is_uploaded_ckyc = TRUE
// Both changes happen in one transaction — atomically or not at all
async function confirmCKYCUpload({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.DOWNLOADED);
  assertValidTransition(batch.status, BATCH_STATUS.WAITING_RESPONSE);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The WHERE clause includes status = 'DOWNLOADED' as a safety guard
    // against race conditions (two requests confirming simultaneously)
    const result = await client.query(
      `UPDATE ckyc_batches
       SET status = 'WAITING_RESPONSE', is_uploaded_ckyc = TRUE
       WHERE id = $1 AND status = 'DOWNLOADED'
       RETURNING *`,
      [batch.id]
    );

    if (result.rows.length === 0) {
      throw new AppError(
        'Batch status has changed since this request was made. Please refresh and try again.',
        409,
        ERROR_CODES.INVALID_STATE_TRANSITION
      );
    }

    // Audit log inside the same transaction
    await _insertAuditLog({
      userId,
      action:    AUDIT_ACTIONS.CKYC_UPLOAD_CONFIRMED,
      batchId:   batch.id,
      ipAddress,
      metadata: {
        target_date:    batch.target_date,
        batch_sequence: batch.batch_sequence,
      },
    }, client);

    await client.query('COMMIT');
    return result.rows[0];

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── GET /batches/:id/response-upload-url ─────────────────────────
// Validate Response filename → return presigned PUT URL for direct R2 upload
async function getResponseUploadUrl({ batchId, filename, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.WAITING_RESPONSE);

  // 4-step filename validation — throws AppError with details if any step fails
  validateResponseFilename(filename, {
    batch_sequence: batch.batch_sequence,
    target_date:    batch.target_date instanceof Date
      ? batch.target_date.toISOString().split('T')[0]
      : batch.target_date,
  });

  // Build the R2 key where the browser will PUT the file
  const r2Key = r2Paths.responseFile(batch.target_date, filename);

  // Issue presigned PUT URL — browser uploads directly, never through Node.js
  const { url, expiresAt } = await r2Service.getPresignedUploadUrl(r2Key, 'text/plain');

  // Log after validation passes (intent audit entry)
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.RESPONSE_UPLOAD_INITIATED,
    batchId:   batch.id,
    ipAddress,
    metadata: {
      target_date:        batch.target_date,
      validated_filename: filename,
    },
  });

  return { url, r2_key: r2Key, expires_at: expiresAt };
}

// ── POST /batches/:id/process-response ───────────────────────────
// Confirm file exists in R2 → update DB → enqueue analysis job
async function processResponse({ batchId, filename, userId, ipAddress, requestId }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.WAITING_RESPONSE);

  // Build the key where we expect the file to be
  const r2Key = r2Paths.responseFile(batch.target_date, filename);

  // Verify the file actually landed in R2 — browser could claim upload without doing it
  const fileInfo = await r2Service.fileExists(r2Key);
  if (!fileInfo.exists) {
    throw new AppError(
      'Response file was not found in storage. Please complete the file upload before confirming.',
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { expected_r2_key: r2Key }
    );
  }

  assertValidTransition(batch.status, BATCH_STATUS.PROCESSING_RESPONSE);

  // Update batch: set response_file_key + transition to PROCESSING_RESPONSE
  const result = await pool.query(
    `UPDATE ckyc_batches
     SET status = 'PROCESSING_RESPONSE', response_file_key = $2
     WHERE id = $1
     RETURNING *`,
    [batch.id, r2Key]
  );

  // Log outcome (file confirmed in R2)
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.RESPONSE_FILE_UPLOADED,
    batchId:   batch.id,
    ipAddress,
    metadata: {
      target_date:     batch.target_date,
      filename,
      file_size_bytes: fileInfo.size || 0,
    },
  });

  // Enqueue response analysis job
  // The worker will parse the response file and enqueue the two downstream jobs
  await enqueueResponseAnalysis({
    batchId:         batch.id,
    targetDate:      batch.target_date,
    batchSequence:   batch.batch_sequence,
    responseFileKey: r2Key,
    requestId,
  });

  return { batch_id: result.rows[0].id, status: result.rows[0].status };
}

// ── GET /batches/:id/final-urls ───────────────────────────────────
// Return presigned download URLs for both final output files
async function getFinalUrls({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.COMPLETED);

  if (!batch.download_file_key || !batch.upload_file_key) {
    throw new AppError(
      'Final files are not yet available. Batch may still be processing.',
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }

  const seq     = String(batch.batch_sequence).padStart(5, '0');
  const dateStr = formatDateForFilename(batch.target_date);

  // Download file: IN3860_{DATE}_V1.1_S{SEQ}.txt
  const downloadFilename = `IN3860_${dateStr}_V1.1_S${seq}.txt`;
  // Upload file: extract original filename from the R2 key
  const uploadFilename   = batch.upload_file_key.split('/').pop();

  // Generate both presigned URLs in parallel
  const [downloadResult, uploadResult] = await Promise.all([
    r2Service.getPresignedDownloadUrl(batch.download_file_key, downloadFilename),
    r2Service.getPresignedDownloadUrl(batch.upload_file_key, uploadFilename),
  ]);

  // Log final file download
  await _insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.FINAL_FILE_DOWNLOADED,
    batchId:   batch.id,
    ipAddress,
    metadata: {
      target_date: batch.target_date,
      file_type:   'both',
    },
  });

  return {
    download_file: {
      url:        downloadResult.url,
      filename:   downloadFilename,
      expires_at: downloadResult.expiresAt,
    },
    upload_file: {
      url:        uploadResult.url,
      filename:   uploadFilename,
      expires_at: uploadResult.expiresAt,
    },
  };
}

module.exports = {
  listBatches,
  getBatchById,
  triggerDailyBatch,
  generateBatches,
  getSearchDownloadUrl,
  confirmCKYCUpload,
  getResponseUploadUrl,
  processResponse,
  getFinalUrls,
};