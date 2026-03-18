// backend/src/controllers/batches.controller.js
'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const batchService              = require('../services/batch.service');
const { listStandaloneSearches } = require('../services/audit.service');

// ── GET /api/v1/batches ───────────────────────────────────────────
async function handleListBatches(req, res, next) {
  try {
    const { start_date, end_date, status, page, limit } = req.query;

    const result = await batchService.listBatches({
      startDate: start_date,
      endDate:   end_date,
      status,
      page,
      limit,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/batches/:id ───────────────────────────────────────
async function handleGetBatch(req, res, next) {
  try {
    const batch = await batchService.getBatchById({
      batchId:   req.params.id,
      userId:    req.user.id,
      ipAddress: req.ip,
    });

    res.status(200).json({ success: true, data: { batch } });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/batches/generate ────────────────────────────────
async function handleGenerateBatches(req, res, next) {
  try {
    const { start_date, end_date } = req.body;

    if (!start_date || !end_date) {
      throw new AppError(
        'Request body must include start_date and end_date in YYYY-MM-DD format.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    // Basic format validation
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(start_date) || !dateRegex.test(end_date)) {
      throw new AppError(
        'start_date and end_date must be in YYYY-MM-DD format.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const result = await batchService.generateBatches({
      startDate: start_date,
      endDate:   end_date,
      userId:    req.user.id,
      ipAddress: req.ip,
      requestId: req.requestId,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/batches/:id/search-url ───────────────────────────
async function handleGetSearchUrl(req, res, next) {
  try {
    const result = await batchService.getSearchDownloadUrl({
      batchId:   req.params.id,
      userId:    req.user.id,
      ipAddress: req.ip,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/batches/:id/confirm-upload ───────────────────────
async function handleConfirmUpload(req, res, next) {
  try {
    const batch = await batchService.confirmCKYCUpload({
      batchId:   req.params.id,
      userId:    req.user.id,
      ipAddress: req.ip,
    });

    res.status(200).json({
      success: true,
      data: {
        message:          'CKYC portal upload confirmed successfully.',
        batch_id:         batch.id,
        status:           batch.status,
        is_uploaded_ckyc: batch.is_uploaded_ckyc,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/batches/:id/response-upload-url ───────────────────
async function handleGetResponseUploadUrl(req, res, next) {
  try {
    const { filename } = req.query;

    if (!filename) {
      throw new AppError(
        'Query parameter "filename" is required.',
        400,
        ERROR_CODES.INVALID_REQUEST,
        { hint: 'Example: ?filename=IN3860_09032026_V1.1_S00016_Res.txt' }
      );
    }

    const result = await batchService.getResponseUploadUrl({
      batchId:   req.params.id,
      filename,
      userId:    req.user.id,
      ipAddress: req.ip,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/batches/:id/process-response ─────────────────────
async function handleProcessResponse(req, res, next) {
  try {
    const { filename } = req.body;

    if (!filename) {
      throw new AppError(
        'Request body must include "filename".',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const result = await batchService.processResponse({
      batchId:   req.params.id,
      filename,
      userId:    req.user.id,
      ipAddress: req.ip,
      requestId: req.requestId,
    });

    res.status(200).json({
      success: true,
      data: {
        message: 'Response file confirmed. Analysis job has been queued.',
        ...result,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/v1/batches/:id/final-urls ───────────────────────────
async function handleGetFinalUrls(req, res, next) {
  try {
    const result = await batchService.getFinalUrls({
      batchId:   req.params.id,
      userId:    req.user.id,
      ipAddress: req.ip,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/v1/batches/generate-upload ─────────────────────────
async function handleGenerateUpload(req, res, next) {
  try {
    const { pan_list, source_batch_id } = req.body;

    if (!pan_list && !source_batch_id) {
      throw new AppError(
        'Request body must include either pan_list (array of PAN strings) or source_batch_id.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    if (pan_list && !Array.isArray(pan_list)) {
      throw new AppError(
        'pan_list must be an array of PAN strings.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const result = await batchService.generateStandaloneUpload({
      panList:       pan_list || null,
      sourceBatchId: source_batch_id || null,
      userId:        req.user.id,
      ipAddress:     req.ip,
      requestId:     req.requestId,
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function handleGenerateSearchStandalone(req, res, next) {
  try {
    const { target_date } = req.body;

    if (!target_date) {
      throw new AppError(
        'target_date is required in YYYY-MM-DD format.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(target_date)) {
      throw new AppError(
        'target_date must be in YYYY-MM-DD format.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const result = await batchService.generateSearchStandalone({
      targetDate: target_date,
      userId:     req.user.id,
      ipAddress:  req.ip,
      requestId:  req.requestId,
    });

    res.status(202).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// â”€â”€ GET /api/v1/batches/standalone-searches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleListStandaloneSearches(req, res, next) {
  try {
    const { limit } = req.query;
    const searches = await listStandaloneSearches(limit);
    res.status(200).json({ success: true, data: { searches } });
  } catch (err) {
    next(err);
  }
}

// â”€â”€ GET /api/v1/batches/standalone-search-url â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleGetStandaloneSearchUrl(req, res, next) {
  try {
    const { r2_key, filename } = req.query;
    const result = await batchService.getStandaloneSearchDownloadUrl({
      r2Key:    r2_key,
      filename: filename,
      userId:   req.user.id,
      ipAddress: req.ip,
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function handleStandaloneSearchStream(req, res, next) {
  try {
    const { jobId } = req.params;
    const token = req.query?.token;

    if (!token || typeof token !== 'string') {
      throw new AppError(
        'Missing or invalid stream token.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    const { QueueEvents } = require('bullmq');
    const { createRedisClient } = require('../config/redis');
    const { getQueue, QUEUE_NAMES } = require('../workers/queue');

    const queue = getQueue(QUEUE_NAMES.STANDALONE_SEARCH);
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new AppError('Standalone search job not found.', 404, ERROR_CODES.NOT_FOUND);
    }

    if (job.data?.streamToken !== token) {
      throw new AppError('Invalid stream token.', 401, ERROR_CODES.UNAUTHORIZED);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sendAndClose = (payload) => {
      const eventName = payload.status === 'COMPLETED' ? 'complete' : 'error';
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
    };

    const queueEvents = new QueueEvents(QUEUE_NAMES.STANDALONE_SEARCH, {
      connection: createRedisClient(),
    });

    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      try {
        await queueEvents.close();
      } catch {
        // ignore
      }
    };

    req.on('close', () => {
      cleanup();
    });

    try {
      const returnValue = await job.waitUntilFinished(queueEvents);
      sendAndClose({ status: 'COMPLETED', result: returnValue });
    } catch (err) {
      const reason = err?.message || job.failedReason || 'Standalone search failed.';
      sendAndClose({ status: 'FAILED', error: reason });
    } finally {
      cleanup();
    }
  } catch (err) {
    next(err);
  }
}


module.exports = {
  handleListBatches,
  handleGetBatch,
  handleGenerateBatches,
  handleGetSearchUrl,
  handleConfirmUpload,
  handleGetResponseUploadUrl,
  handleProcessResponse,
  handleGetFinalUrls,
  handleGenerateUpload,  
  handleGenerateSearchStandalone,
  handleListStandaloneSearches,
  handleGetStandaloneSearchUrl,
  handleStandaloneSearchStream,
};
