// backend/src/controllers/batches.controller.js
'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const batchService              = require('../services/batch.service');

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

module.exports = {
  handleListBatches,
  handleGetBatch,
  handleGenerateBatches,
  handleGetSearchUrl,
  handleConfirmUpload,
  handleGetResponseUploadUrl,
  handleProcessResponse,
  handleGetFinalUrls,
};