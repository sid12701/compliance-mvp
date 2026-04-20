'use strict';

const { randomUUID } = require('crypto');
const { pool } = require('../config/database');
const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const {
  BATCH_STATUS,
  assertValidTransition,
  SEARCH_DOWNLOAD_ELIGIBLE,
  FINAL_DOWNLOAD_ELIGIBLE,
} = require('../constants/batchStatus');
const { r2Paths } = require('../utils/r2Paths');
const { validateResponseFilename } = require('../utils/fileNameValidator');
const {
  formatDateForFilename,
  todayIST,
  isFutureDate,
  getWorkingDatesInRange,
} = require('../utils/istTime');
const { runPythonScript } = require('../utils/ipcRunner');
const { getNextFileSequence } = require('../utils/fileSequence');
const r2Service = require('./r2.service');
const { appendBatchTimeline } = require('./timeline.service');
const {
  enqueueSearchGeneration,
  enqueueResponseAnalysis,
  enqueueStandaloneSearch,
} = require('../workers/queue');
const { ensureWorkersRunning } = require('../workers/launcher');

const BATCH_SELECT = `
  SELECT
    b.id,
    b.target_date,
    b.batch_sequence,
    b.status,
    b.last_downloaded_at,
    b.created_by,
    b.created_at,
    b.updated_at,
    b.error_message,
    b.search_file_key,
    b.response_file_key,
    b.download_file_key,
    b.upload_file_key,
    b.pan_dob_r2_key,
    b.response_analysis_result,
    b.search_uploaded_at,
    b.search_uploaded_by,
    b.final_upload_uploaded_at,
    b.final_upload_uploaded_by,
    b.primary_ops_user_id,
    b.secondary_ops_user_id,
    b.current_assignee_user_id,
    COALESCE(b.timeline, '[]'::jsonb) AS timeline,
    b.search_file_key IS NOT NULL AS has_search_file,
    b.response_file_key IS NOT NULL AS has_response_file,
    b.download_file_key IS NOT NULL AS has_download_file,
    b.upload_file_key IS NOT NULL AS has_upload_file,
    b.search_uploaded_at IS NOT NULL AS has_search_upload,
    b.final_upload_uploaded_at IS NOT NULL AS has_final_upload,
    creator.username AS created_by_username,
    primary_user.username AS primary_ops_username,
    secondary_user.username AS secondary_ops_username,
    assignee_user.username AS current_assignee_username,
    search_user.username AS search_uploaded_by_username,
    final_user.username AS final_upload_uploaded_by_username
  FROM ckyc_batches b
  LEFT JOIN users creator ON creator.id = b.created_by
  LEFT JOIN users primary_user ON primary_user.id = b.primary_ops_user_id
  LEFT JOIN users secondary_user ON secondary_user.id = b.secondary_ops_user_id
  LEFT JOIN users assignee_user ON assignee_user.id = b.current_assignee_user_id
  LEFT JOIN users search_user ON search_user.id = b.search_uploaded_by
  LEFT JOIN users final_user ON final_user.id = b.final_upload_uploaded_by
`;

function _buildSearchFileKey({ targetDate, fileSeq, filenameDate }) {
  const seqStr = String(fileSeq).padStart(5, '0');
  const filename = `IN3860_${filenameDate}_V1.1_S${seqStr}.txt`;
  return {
    r2Key: r2Paths.searchFile(targetDate, filename),
    filename,
  };
}

function _formatDateOnly(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'string') return dateVal.split('T')[0];
  if (dateVal instanceof Date) return dateVal.toISOString().split('T')[0];
  return String(dateVal).split('T')[0];
}

function _assertNotToday(targetDate, actionLabel) {
  const target = _formatDateOnly(targetDate);
  const today = todayIST();
  if (target && target === today) {
    throw new AppError(
      `${actionLabel} for today's batch is disabled until the day ends (IST).`,
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { target_date: target, today }
    );
  }
}

function _assertStatus(batch, ...allowedStatuses) {
  if (!allowedStatuses.includes(batch.status)) {
    throw new AppError(
      `This action requires the batch to be in [${allowedStatuses.join(' or ')}] status. Current status: "${batch.status}".`,
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }
}

function _assertBatchAssignee(batch, user) {
  if (!user) {
    throw new AppError('Authentication required.', 401, ERROR_CODES.UNAUTHORIZED);
  }

  if (user.role === 'dev') return;

  if (!batch.current_assignee_user_id || batch.current_assignee_user_id !== user.id) {
    throw new AppError(
      'Only the current assigned user can perform this action.',
      403,
      ERROR_CODES.FORBIDDEN,
      {
        current_assignee_user_id: batch.current_assignee_user_id,
        current_assignee_username: batch.current_assignee_username,
      }
    );
  }
}

async function _getBatchOrThrow(batchId, client = pool) {
  const result = await client.query(
    `${BATCH_SELECT} WHERE b.id = $1`,
    [batchId]
  );

  if (result.rows.length === 0) {
    throw new AppError(
      `Batch with ID ${batchId} was not found.`,
      404,
      ERROR_CODES.BATCH_NOT_FOUND
    );
  }

  return result.rows[0];
}

async function _validateOpsPair(primaryOpsUserId, secondaryOpsUserId) {
  if (!primaryOpsUserId || !secondaryOpsUserId) {
    throw new AppError(
      'primary_ops_user_id and secondary_ops_user_id are required.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  if (primaryOpsUserId === secondaryOpsUserId) {
    throw new AppError(
      'Primary and secondary assigned users must be different.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const result = await pool.query(
    `SELECT id, username, role, is_active
     FROM users
     WHERE id = ANY($1::uuid[])`,
    [[primaryOpsUserId, secondaryOpsUserId]]
  );

  if (result.rows.length !== 2) {
    throw new AppError(
      'Both assigned users must exist.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const invalidUser = result.rows.find(
    (row) => !['operator', 'dev'].includes(row.role) || !row.is_active
  );
  if (invalidUser) {
    throw new AppError(
      'Assigned users must be active operator or admin users.',
      400,
      ERROR_CODES.INVALID_REQUEST,
      { invalid_user_id: invalidUser.id, invalid_username: invalidUser.username }
    );
  }
}

function _nextActionForStatus(status) {
  switch (status) {
    case BATCH_STATUS.PROCESSING:
      return 'Generating search file';
    case BATCH_STATUS.GENERATED:
      return 'Download search file';
    case BATCH_STATUS.DOWNLOADED:
      return 'Confirm search upload on CKYC';
    case BATCH_STATUS.WAITING_RESPONSE:
      return 'Upload and confirm response file';
    case BATCH_STATUS.PROCESSING_RESPONSE:
      return 'Generating final files';
    case BATCH_STATUS.FINAL_FILES_READY:
      return 'Confirm final upload on CKYC';
    case BATCH_STATUS.COMPLETED:
      return 'Completed';
    case BATCH_STATUS.FAILED:
      return 'Retry batch';
    default:
      return 'Unknown';
  }
}

function _decorateBatch(batch) {
  return {
    ...batch,
    next_action: _nextActionForStatus(batch.status),
  };
}

async function listBatches({ startDate, endDate, status, page = 1, limit = 20 }) {
  const safeLimit = Math.min(parseInt(limit, 10) || 20, 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const from = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  const to = endDate || todayIST();

  const params = [from, to, status || null, safeLimit, offset];

  const [batchesResult, countResult] = await Promise.all([
    pool.query(
      `${BATCH_SELECT}
       WHERE b.target_date >= $1::date
         AND b.target_date <= $2::date
         AND ($3::text IS NULL OR b.status = $3)
       ORDER BY b.target_date DESC, b.created_at DESC
       LIMIT $4 OFFSET $5`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM ckyc_batches b
       WHERE b.target_date >= $1::date
         AND b.target_date <= $2::date
         AND ($3::text IS NULL OR b.status = $3)`,
      params.slice(0, 3)
    ),
  ]);

  const total = parseInt(countResult.rows[0].total, 10);

  return {
    batches: batchesResult.rows.map(_decorateBatch),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total_count: total,
      total_pages: Math.ceil(total / safeLimit),
    },
  };
}

async function getBatchById({ batchId }) {
  const batch = await _getBatchOrThrow(batchId);
  return _decorateBatch(batch);
}

async function listOperators() {
  const result = await pool.query(
    `SELECT id, username
     FROM users
     WHERE role IN ('operator', 'dev') AND is_active = TRUE
     ORDER BY username ASC`
  );

  return result.rows;
}

async function generateBatches({
  startDate,
  endDate,
  primaryOpsUserId,
  secondaryOpsUserId,
  user,
  requestId,
}) {
  if (isFutureDate(startDate) || isFutureDate(endDate)) {
    throw new AppError(
      'Batch dates cannot be in the future.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  if (startDate > endDate) {
    throw new AppError(
      'start_date must be before or equal to end_date.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  await _validateOpsPair(primaryOpsUserId, secondaryOpsUserId);

  const dates = getWorkingDatesInRange(startDate, endDate);
  if (dates.length === 0) {
    throw new AppError(
      'No dates found in the selected range.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const datesQueued = [];
  const datesSkipped = [];
  const datesFailedRetriggered = [];

  for (const date of dates) {
    const existing = await pool.query(
      `SELECT id FROM ckyc_batches
       WHERE target_date = $1 AND status != 'FAILED'`,
      [date]
    );

    if (existing.rows.length > 0) {
      datesSkipped.push(date);
      continue;
    }

    const failed = await pool.query(
      `SELECT id
       FROM ckyc_batches
       WHERE target_date = $1 AND status = 'FAILED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [date]
    );

    const fileSeq = await getNextFileSequence('search');
    const filenameDate = formatDateForFilename(todayIST());
    const { r2Key } = _buildSearchFileKey({
      targetDate: date,
      fileSeq,
      filenameDate,
    });

    let batchId;
    let eventType = 'batch_created';

    if (failed.rows.length > 0) {
      const retryResult = await pool.query(
        `UPDATE ckyc_batches
         SET status = 'PROCESSING',
             batch_sequence = $2,
             created_by = $3,
             error_message = NULL,
             search_file_key = NULL,
             response_file_key = NULL,
             download_file_key = NULL,
             upload_file_key = NULL,
             response_analysis_result = NULL,
             search_uploaded_at = NULL,
             search_uploaded_by = NULL,
             final_upload_uploaded_at = NULL,
             final_upload_uploaded_by = NULL,
             primary_ops_user_id = $4,
             secondary_ops_user_id = $5,
             current_assignee_user_id = $4
         WHERE id = $1
         RETURNING id`,
        [failed.rows[0].id, fileSeq, user.id, primaryOpsUserId, secondaryOpsUserId]
      );

      batchId = retryResult.rows[0].id;
      eventType = 'batch_retried';
      datesFailedRetriggered.push(date);
    } else {
      const created = await pool.query(
        `INSERT INTO ckyc_batches (
          target_date,
          batch_sequence,
          status,
          created_by,
          primary_ops_user_id,
          secondary_ops_user_id,
          current_assignee_user_id
        )
         VALUES ($1, $2, 'PROCESSING', $3, $4, $5, $4)
         RETURNING id`,
        [date, fileSeq, user.id, primaryOpsUserId, secondaryOpsUserId]
      );

      batchId = created.rows[0].id;
      datesQueued.push(date);
    }

    await appendBatchTimeline({
      batchId,
      type: eventType,
      user,
      metadata: {
        target_date: date,
        batch_sequence: fileSeq,
        primary_ops_user_id: primaryOpsUserId,
        secondary_ops_user_id: secondaryOpsUserId,
        current_assignee_user_id: primaryOpsUserId,
      },
    });

    await enqueueSearchGeneration({
      batchId,
      targetDate: date,
      batchSequence: fileSeq,
      r2OutputKey: r2Key,
      requestId,
    });
    ensureWorkersRunning();
  }

  const jobsEnqueued = datesQueued.length + datesFailedRetriggered.length;
  const advisory = jobsEnqueued > 7
    ? `${jobsEnqueued} jobs have been enqueued and will process sequentially. This may take ${Math.ceil(jobsEnqueued * 2)}-${Math.ceil(jobsEnqueued * 3)} minutes to complete.`
    : null;

  return {
    jobs_enqueued: jobsEnqueued,
    dates_queued: datesQueued,
    dates_skipped: datesSkipped,
    dates_failed_retriggered: datesFailedRetriggered,
    advisory,
  };
}

async function getSearchDownloadUrl({ batchId, user }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertNotToday(batch.target_date, 'Download');
  _assertStatus(batch, ...SEARCH_DOWNLOAD_ELIGIBLE);
  _assertBatchAssignee(batch, user);

  if (!batch.search_file_key) {
    throw new AppError(
      'Search file is not yet available for this batch.',
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }

  const downloadFilename = batch.search_file_key.split('/').pop();
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
         SET status = 'DOWNLOADED',
             last_downloaded_at = NOW()
         WHERE id = $1`,
        [batch.id]
      );
    } else {
      await client.query(
        `UPDATE ckyc_batches
         SET last_downloaded_at = NOW()
         WHERE id = $1`,
        [batch.id]
      );
    }

    await appendBatchTimeline({
      batchId: batch.id,
      type: 'search_downloaded',
      user,
      metadata: {
        status_after: batch.status === BATCH_STATUS.GENERATED ? BATCH_STATUS.DOWNLOADED : batch.status,
        url_expires_at: expiresAt,
      },
    }, client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { url, filename: downloadFilename, expires_at: expiresAt };
}

async function confirmCKYCUpload({ batchId, fileType, user }) {
  const batch = await _getBatchOrThrow(batchId);
  _assertBatchAssignee(batch, user);

  if (fileType === 'search') {
    _assertStatus(batch, BATCH_STATUS.DOWNLOADED);
    assertValidTransition(batch.status, BATCH_STATUS.WAITING_RESPONSE);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updated = await client.query(
        `UPDATE ckyc_batches
         SET status = 'WAITING_RESPONSE',
             search_uploaded_at = NOW(),
             search_uploaded_by = $2,
             current_assignee_user_id = secondary_ops_user_id
         WHERE id = $1 AND status = 'DOWNLOADED'
         RETURNING secondary_ops_user_id`,
        [batch.id, user.id]
      );

      if (updated.rows.length === 0) {
        throw new AppError(
          'Batch status has changed since this request was made. Please refresh and try again.',
          409,
          ERROR_CODES.INVALID_STATE_TRANSITION
        );
      }

      await appendBatchTimeline({
        batchId: batch.id,
        type: 'search_upload_confirmed',
        user,
        metadata: {
          status_after: BATCH_STATUS.WAITING_RESPONSE,
          next_assignee_user_id: updated.rows[0].secondary_ops_user_id,
        },
      }, client);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return _decorateBatch(await _getBatchOrThrow(batch.id));
  }

  if (fileType === 'upload') {
    _assertStatus(batch, BATCH_STATUS.FINAL_FILES_READY);
    assertValidTransition(batch.status, BATCH_STATUS.COMPLETED);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updated = await client.query(
        `UPDATE ckyc_batches
         SET status = 'COMPLETED',
             final_upload_uploaded_at = NOW(),
             final_upload_uploaded_by = $2,
             current_assignee_user_id = primary_ops_user_id
         WHERE id = $1 AND status = 'FINAL_FILES_READY'
         RETURNING primary_ops_user_id`,
        [batch.id, user.id]
      );

      if (updated.rows.length === 0) {
        throw new AppError(
          'Batch status has changed since this request was made. Please refresh and try again.',
          409,
          ERROR_CODES.INVALID_STATE_TRANSITION
        );
      }

      await appendBatchTimeline({
        batchId: batch.id,
        type: 'final_upload_confirmed',
        user,
        metadata: {
          status_after: BATCH_STATUS.COMPLETED,
          next_assignee_user_id: updated.rows[0].primary_ops_user_id,
        },
      }, client);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return _decorateBatch(await _getBatchOrThrow(batch.id));
  }

  throw new AppError(
    'file_type must be either "search" or "upload".',
    400,
    ERROR_CODES.INVALID_REQUEST
  );
}

async function getResponseUploadUrl({ batchId, filename, user }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.WAITING_RESPONSE);
  _assertBatchAssignee(batch, user);

  validateResponseFilename(filename, {
    batch_sequence: batch.batch_sequence,
    target_date: batch.target_date instanceof Date
      ? batch.target_date.toISOString().split('T')[0]
      : batch.target_date,
    search_file_key: batch.search_file_key,
  });

  const r2Key = r2Paths.responseFile(batch.target_date, filename);
  const { url, expiresAt } = await r2Service.getPresignedUploadUrl(r2Key, 'text/plain');

  await appendBatchTimeline({
    batchId: batch.id,
    type: 'response_upload_initiated',
    user,
    metadata: { filename },
  });

  return { url, r2_key: r2Key, expires_at: expiresAt };
}

async function processResponse({ batchId, filename, user, requestId }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertStatus(batch, BATCH_STATUS.WAITING_RESPONSE);
  _assertBatchAssignee(batch, user);

  const r2Key = r2Paths.responseFile(batch.target_date, filename);
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

  await pool.query(
    `UPDATE ckyc_batches
     SET status = 'PROCESSING_RESPONSE',
         response_file_key = $2
     WHERE id = $1`,
    [batch.id, r2Key]
  );

  await appendBatchTimeline({
    batchId: batch.id,
    type: 'response_file_confirmed',
    user,
    metadata: {
      filename,
      file_size_bytes: fileInfo.size || 0,
      status_after: BATCH_STATUS.PROCESSING_RESPONSE,
    },
  });

  await enqueueResponseAnalysis({
    batchId: batch.id,
    targetDate: batch.target_date,
    batchSequence: batch.batch_sequence,
    responseFileKey: r2Key,
    requestId,
  });
  ensureWorkersRunning();

  return { batch_id: batch.id, status: BATCH_STATUS.PROCESSING_RESPONSE };
}

async function getFinalUrls({ batchId, user }) {
  const batch = await _getBatchOrThrow(batchId);

  _assertNotToday(batch.target_date, 'Download');
  _assertStatus(batch, ...FINAL_DOWNLOAD_ELIGIBLE);
  _assertBatchAssignee(batch, user);

  if (!batch.download_file_key || !batch.upload_file_key) {
    throw new AppError(
      'Final files are not yet available. Batch may still be processing.',
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
  }

  const downloadFilename = batch.download_file_key.split('/').pop();
  const uploadFilename = batch.upload_file_key.split('/').pop();

  const [downloadResult, uploadResult] = await Promise.all([
    r2Service.getPresignedDownloadUrl(batch.download_file_key, downloadFilename),
    r2Service.getPresignedDownloadUrl(batch.upload_file_key, uploadFilename),
  ]);

  return {
    download_file: {
      url: downloadResult.url,
      filename: downloadFilename,
      expires_at: downloadResult.expiresAt,
    },
    upload_file: {
      url: uploadResult.url,
      filename: uploadFilename,
      expires_at: uploadResult.expiresAt,
    },
  };
}

async function generateUploadFile({ panList, sourceBatchId }) {
  let finalPanList = panList || [];

  if (sourceBatchId) {
    const sourceBatch = await _getBatchOrThrow(sourceBatchId);
    _assertStatus(sourceBatch, BATCH_STATUS.FINAL_FILES_READY, BATCH_STATUS.COMPLETED);

    if (!sourceBatch.response_analysis_result) {
      throw new AppError(
        'The selected batch has no response analysis result available.',
        409,
        ERROR_CODES.INVALID_STATE_TRANSITION
      );
    }

    const analysis = sourceBatch.response_analysis_result;
    finalPanList = analysis.upload_list || analysis.pan_list || analysis.pans || [];

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

  const targetDate = todayIST();
  const fileSeq = await getNextFileSequence('upload');
  const dateStr = formatDateForFilename(new Date());
  const r2Prefix = r2Paths.uploadDir(targetDate);

  const result = await runPythonScript('upload_generator.py', {
    target_date: targetDate,
    batch_sequence: fileSeq,
    pan_list: finalPanList,
    r2_output_key_prefix: r2Prefix,
    filename_date: dateStr,
  });

  if (!result.success) {
    throw new AppError(
      result.error || 'Upload file generation failed.',
      500,
      ERROR_CODES.PYTHON_SCRIPT_FAILED
    );
  }

  const files = await Promise.all(
    (result.files_generated || []).map(async (file) => {
      const filename = file.r2_key.split('/').pop();
      const { url, expiresAt } = await r2Service.getPresignedDownloadUrl(
        file.r2_key,
        filename
      );

      return {
        filename,
        r2_key: file.r2_key,
        file_size_bytes: file.file_size_bytes,
        url,
        expires_at: expiresAt,
      };
    })
  );

  return {
    records_processed: result.records_processed,
    files,
  };
}

async function generateSearchStandalone({ targetDate, requestId, userId, ipAddress }) {
  if (isFutureDate(targetDate)) {
    throw new AppError(
      'target_date cannot be in the future.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const jobId = randomUUID();
  const streamToken = randomUUID();

  await enqueueStandaloneSearch({
    jobId,
    streamToken,
    targetDate,
    requestId,
    userId,
    ipAddress,
  });
  ensureWorkersRunning();

  return { job_id: jobId, stream_token: streamToken };
}

async function getStandaloneSearchDownloadUrl({ r2Key, filename }) {
  if (!r2Key || typeof r2Key !== 'string') {
    throw new AppError(
      'Query parameter "r2_key" is required.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }
  if (!filename || typeof filename !== 'string') {
    throw new AppError(
      'Query parameter "filename" is required.',
      400,
      ERROR_CODES.INVALID_REQUEST
    );
  }

  const match = r2Key.match(/ckyc\/(\d{4}-\d{2}-\d{2})\//);
  if (match && match[1] === todayIST()) {
    throw new AppError(
      "Download for today's search file is disabled until the day ends (IST).",
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { target_date: match[1], today: todayIST() }
    );
  }

  const { url, expiresAt } = await r2Service.getPresignedDownloadUrl(r2Key, filename);
  return { url, filename, expires_at: expiresAt };
}

module.exports = {
  listBatches,
  getBatchById,
  listOperators,
  generateBatches,
  getSearchDownloadUrl,
  confirmCKYCUpload,
  getResponseUploadUrl,
  processResponse,
  getFinalUrls,
  generateUploadFile,
  generateSearchStandalone,
  getStandaloneSearchDownloadUrl,
  _getBatchOrThrow,
};
