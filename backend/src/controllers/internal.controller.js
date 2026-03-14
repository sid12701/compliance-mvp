// backend/src/controllers/internal.controller.js
'use strict';

const { timingSafeEqual } = require('crypto');
const config              = require('../config/env');
const { AppError,
        ERROR_CODES }     = require('../constants/errorCodes');
const batchService        = require('../services/batch.service');
const { todayIST }        = require('../utils/istTime');

// ── POST /api/v1/internal/trigger-daily-batch ─────────────────────
async function handleTriggerDailyBatch(req, res, next) {
  try {
    // ── Secret verification ───────────────────────────────────
    const providedSecret = req.headers['x-cron-secret'];

    if (!providedSecret) {
      throw new AppError(
        'Missing x-cron-secret header.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // timingSafeEqual requires same-length Buffers
    // If lengths differ, the secret is wrong — reject immediately
    const expected = Buffer.from(config.cron.secret, 'utf8');
    const provided = Buffer.from(providedSecret, 'utf8');

    const secretMatches =
      expected.length === provided.length &&
      timingSafeEqual(expected, provided);

    if (!secretMatches) {
      throw new AppError(
        'Invalid x-cron-secret.',
        401,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // ── Determine target date ─────────────────────────────────
    // CRON always uses today's IST date.
    // Body can optionally override for manual testing.
    const targetDate = req.body?.target_date || todayIST();

    // Basic date format validation
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      throw new AppError(
        'target_date must be in YYYY-MM-DD format.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const result = await batchService.triggerDailyBatch({
      targetDate,
      requestId: req.requestId,
    });

    if (result.skipped) {
      return res.status(200).json({
        success: true,
        data: {
          message:    `Batch for ${targetDate} already exists — skipped.`,
          batch_id:   result.batch.id,
          status:     result.batch.status,
          skipped:    true,
        },
      });
    }

    res.status(201).json({
      success: true,
      data: {
        message:    `Batch for ${targetDate} created and queued for processing.`,
        batch_id:   result.batch.id,
        status:     result.batch.status,
        skipped:    false,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { handleTriggerDailyBatch };