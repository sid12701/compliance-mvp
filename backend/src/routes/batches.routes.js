// backend/src/routes/batches.routes.js
'use strict';

const express              = require('express');
const { authenticate }     = require('../middleware/authenticate');
const {
  handleListBatches,
  handleGetBatch,
  handleGenerateBatches,
  handleGetSearchUrl,
  handleConfirmUpload,
  handleGetResponseUploadUrl,
  handleProcessResponse,
  handleGetFinalUrls,
  handleGenerateUpload,
} = require('../controllers/batches.controller');

const router = express.Router();

// All batch routes require authentication
router.use(authenticate);

// ── Batch listing and detail ──────────────────────────────────────
router.get('/',   handleListBatches);
router.get('/:id',handleGetBatch);

// ── Batch generation (manual)
router.post('/generate',handleGenerateBatches);

// ── Search file download 
router.get('/:id/search-url', handleGetSearchUrl);

// ── CKYC portal upload confirmation ───────────────────────────────
router.post('/:id/confirm-upload',handleConfirmUpload);

// ── Response file upload flow ──────────────────────────────────────
router.get('/:id/response-upload-url',handleGetResponseUploadUrl);
router.post('/:id/process-response',handleProcessResponse);

// ── Final file download ────────────────────────────────────────────
router.get('/:id/final-urls',handleGetFinalUrls);

// ── Batch generation (manual)
router.post('/generate', handleGenerateBatches);

// ── Standalone bulk upload generation  ← ADD THIS
router.post('/generate-upload', handleGenerateUpload);


module.exports = router;