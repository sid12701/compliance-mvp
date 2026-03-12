// backend/src/routes/internal.routes.js
'use strict';

const express                    = require('express');
const { handleTriggerDailyBatch } = require('../controllers/internal.controller');

const router = express.Router();

// ── POST /api/v1/internal/trigger-daily-batch ─────────────────────
// Called by CRON scheduler — no JWT, uses x-cron-secret header instead
router.post('/trigger-daily-batch', handleTriggerDailyBatch);

module.exports = router;