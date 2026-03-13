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
const { insertAuditLog }              = require('./audit.service');
const { enqueueSearchGeneration,
        enqueueResponseAnalysis }     = require('../workers/queue');
const { runPythonScript }             = require('../utils/ipcRunner');
// ════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════════════════

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

function _buildSearchFileKey(batch) {
  const seq      = String(batch.batch_sequence).padStart(5, '0');
  const dateStr  = formatDateForFilename(batch.target_date);
  const filename = `IN3860_${dateStr}_V1.1_S${seq}.txt`;
  return r2Paths.searchFile(batch.target_date, filename);
}

function _buildSearchDownloadFilename(batch) {
  const seq      = String(batch.batch_sequence).padStart(5, '0');
  const todayStr = formatDateForFilename(new Date());
  return `IN3860_${todayStr}_V1.1_S${seq}.txt`;
}

async function _getNextBatchSequence() {
  const result = await pool.query(
    `SELECT COALESCE(MAX(batch_sequence), 0) + 1 AS next_seq FROM ckyc_batches`
  );
  return parseInt(result.rows[0].next_seq, 10);
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC SERVICE FUNCTIONS
// ════════════════════════════════════════════════════════════════════

async function listBatches({ startDate, endDate, status, page = 1, limit = 20 }) {
  const safeLimit  = Math.min(parseInt(limit, 10)  || 20, 100);
  const safePage   = Math.max(parseInt(page, 10)   || 1,  1);
  const offset     = (safePage - 1) * safeLimit;

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

async function getBatchById({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.BATCH_ACCESSED,
    batchId:   batch.id,
    ipAddress,
    metadata:  { target_date: batch.target_date, batch_status: batch.status },
  });

  return batch;
}

async function triggerDailyBatch({ targetDate, requestId }) {
  const existing = await pool.query(
    `SELECT id, status, batch_sequence
     FROM ckyc_batches
     WHERE target_date = $1 AND status != 'FAILED'`,
    [targetDate]
  );

  if (existing.rows.length > 0) {
    return { skipped: true, batch: existing.rows[0] };
  }

  const failed = await pool.query(
    `SELECT * FROM ckyc_batches
     WHERE target_date = $1 AND status = 'FAILED'
     ORDER BY created_at DESC LIMIT 1`,
    [targetDate]
  );

  let batch;

  if (failed.rows.length > 0) {
    const result = await pool.query(
      `UPDATE ckyc_batches
       SET status = 'PROCESSING', error_message = NULL
       WHERE id = $1
       RETURNING *`,
      [failed.rows[0].id]
    );
    batch = result.rows[0];
  } else {
    const batchSequence = await _getNextBatchSequence();
    const result        = await pool.query(
      `INSERT INTO ckyc_batches (target_date, batch_sequence, status, created_by)
       VALUES ($1, $2, 'PROCESSING', NULL)
       RETURNING *`,
      [targetDate, batchSequence]
    );
    batch = result.rows[0];
  }

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

async function generateBatches({ startDate, endDate, userId, ipAddress, requestId }) {
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

  const dates = getWorkingDatesInRange(startDate, endDate);

  if (dates.length === 0) {
    throw new AppError(
      'No working days found in the selected date range. Sundays are excluded.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.MANUAL_GENERATION_TRIGGERED,
    batchId:   null,
    ipAddress,
    metadata:  {
      date_range_start: startDate,
      date_range_end:   endDate,
      dates_requested:  dates.length,
    },
  });

  const datesQueued            = [];
  const datesSkipped           = [];
  const datesFailedRetriggered = [];

  for (const date of dates) {
    const existing = await pool.query(
      `SELECT id, status FROM ckyc_batches
       WHERE target_date = $1 AND status != 'FAILED'`,
      [date]
    );

    if (existing.rows.length > 0) {
      datesSkipped.push(date);
      continue;
    }

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

    await enqueueSearchGeneration({
      batchId:       batch.id,
      targetDate:    date,
      batchSequence: batch.batch_sequence,
      r2OutputKey:   _buildSearchFileKey(batch),
      requestId,
    });
  }

  const jobsEnqueued = datesQueued.length + datesFailedRetriggered.length;

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

async function getSearchDownloadUrl({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, ...SEARCH_DOWNLOAD_ELIGIBLE);

  if (!batch.search_file_key) {
    throw new AppError(
      'Search file is not yet available for this batch.',
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.SEARCH_FILE_URL_REQUESTED,
    batchId:   batch.id,
    ipAddress,
    metadata:  {
      target_date:    batch.target_date,
      batch_sequence: batch.batch_sequence,
    },
  });

  const downloadFilename = _buildSearchDownloadFilename(batch);

  const { url, expiresAt } = await r2Service.getPresignedDownloadUrl(
    batch.search_file_key,
    downloadFilename
  );

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

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.SEARCH_FILE_DOWNLOADED,
    batchId:   batch.id,
    ipAddress,
    metadata:  {
      target_date:    batch.target_date,
      batch_sequence: batch.batch_sequence,
      url_expires_at: expiresAt,
    },
  });

  return { url, filename: downloadFilename, expires_at: expiresAt };
}

async function confirmCKYCUpload({ batchId, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.DOWNLOADED);
  assertValidTransition(batch.status, BATCH_STATUS.WAITING_RESPONSE);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    await insertAuditLog({
      userId,
      action:    AUDIT_ACTIONS.CKYC_UPLOAD_CONFIRMED,
      batchId:   batch.id,
      ipAddress,
      metadata:  {
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

async function getResponseUploadUrl({ batchId, filename, userId, ipAddress }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.WAITING_RESPONSE);

  validateResponseFilename(filename, {
    batch_sequence: batch.batch_sequence,
    target_date:    batch.target_date instanceof Date
      ? batch.target_date.toISOString().split('T')[0]
      : batch.target_date,
  });

  const r2Key = r2Paths.responseFile(batch.target_date, filename);

  const { url, expiresAt } = await r2Service.getPresignedUploadUrl(r2Key, 'text/plain');

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.RESPONSE_UPLOAD_INITIATED,
    batchId:   batch.id,
    ipAddress,
    metadata:  {
      target_date:        batch.target_date,
      validated_filename: filename,
    },
  });

  return { url, r2_key: r2Key, expires_at: expiresAt };
}

async function processResponse({ batchId, filename, userId, ipAddress, requestId }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.WAITING_RESPONSE);

  const r2Key    = r2Paths.responseFile(batch.target_date, filename);
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

  const result = await pool.query(
    `UPDATE ckyc_batches
     SET status = 'PROCESSING_RESPONSE', response_file_key = $2
     WHERE id = $1
     RETURNING *`,
    [batch.id, r2Key]
  );

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.RESPONSE_FILE_UPLOADED,
    batchId:   batch.id,
    ipAddress,
    metadata:  {
      target_date:     batch.target_date,
      filename,
      file_size_bytes: fileInfo.size || 0,
    },
  });

  await enqueueResponseAnalysis({
    batchId:         batch.id,
    targetDate:      batch.target_date,
    batchSequence:   batch.batch_sequence,
    responseFileKey: r2Key,
    requestId,
  });

  return { batch_id: result.rows[0].id, status: result.rows[0].status };
}

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

  const downloadFilename = `IN3860_${dateStr}_V1.1_S${seq}.txt`;
  const uploadFilename   = batch.upload_file_key.split('/').pop();

  const [downloadResult, uploadResult] = await Promise.all([
    r2Service.getPresignedDownloadUrl(batch.download_file_key, downloadFilename),
    r2Service.getPresignedDownloadUrl(batch.upload_file_key, uploadFilename),
  ]);

  await insertAuditLog({
    userId,
    action:    AUDIT_ACTIONS.FINAL_FILE_DOWNLOADED,
    batchId:   batch.id,
    ipAddress,
    metadata:  {
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


async function generateUploadFile({ panList, sourceBatchId, userId, ipAddress }) {
  let finalPanList = panList || [];

  // If using a completed batch's response analysis instead of manual PANs
  if (sourceBatchId) {
    const sourceBatch = await _getBatchOrThrow(sourceBatchId);
    _assertStatus(sourceBatch, BATCH_STATUS.COMPLETED);

    if (!sourceBatch.response_analysis_result) {
      throw new AppError(
        'The selected batch has no response analysis result available.',
        409,
        ERROR_CODES.INVALID_STATE_TRANSITION
      );
    }

    const analysis = sourceBatch.response_analysis_result;
    finalPanList   = analysis.pan_list || analysis.pans || [];

    if (finalPanList.length === 0) {
      throw new AppError(
        'No PANs found in the selected batch response analysis.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }
  }

  if (!finalPanList || finalPanList.length === 0) {
    throw new AppError(
      'Either pan_list or source_batch_id must be provided.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const targetDate    = todayIST();
  const batchSequence = await _getNextBatchSequence();
  const r2Prefix      = r2Paths.uploadDir(targetDate);

  const result = await runPythonScript('upload_generator.py', {
    target_date:          targetDate,
    batch_sequence:       batchSequence,
    pan_list:             finalPanList,
    r2_output_key_prefix: r2Prefix,
  });

  if (!result.success) {
    throw new AppError(
      result.error || 'Upload file generation failed.',
      500,
      ERROR_CODES.PYTHON_SCRIPT_FAILED
    );
  }

  // Get presigned download URLs for all generated files
  const files = await Promise.all(
    (result.files_generated || []).map(async (f) => {
      const filename = f.r2_key.split('/').pop();
      const { url, expiresAt } = await r2Service.getPresignedDownloadUrl(
        f.r2_key,
        filename
      );
      return {
        filename,
        r2_key:          f.r2_key,
        file_size_bytes: f.file_size_bytes,
        url,
        expires_at:      expiresAt,
      };
    })
  );

  await insertAuditLog({
    userId,
    action:   AUDIT_ACTIONS.UPLOAD_FILE_GENERATED || 'UPLOAD_FILE_GENERATED',
    batchId:  null,
    ipAddress,
    metadata: {
      target_date:       targetDate,
      records_processed: result.records_processed,
      files_count:       files.length,
      source:            sourceBatchId ? `batch:${sourceBatchId}` : 'manual_pan_list',
    },
  });

  return {
    records_processed: result.records_processed,
    files,
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
  generateUploadFile
};