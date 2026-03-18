// backend/src/routes/batches.routes.js
'use strict';

const express          = require('express');
const { authenticate } = require('../middleware/authenticate');
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
  handleGenerateSearchStandalone,
  handleListStandaloneSearches,
  handleGetStandaloneSearchUrl,
  handleStandaloneSearchStream,
} = require('../controllers/batches.controller');

const router = express.Router();

// Standalone search SSE stream (uses stream token, no auth header available)
router.get('/standalone-search/stream/:jobId', handleStandaloneSearchStream);

// All other batch routes require authentication
router.use(authenticate);

// Batch listing and detail
router.get('/',    handleListBatches);

// Standalone search listing + url (must be before /:id)
router.get('/standalone-searches', handleListStandaloneSearches);
router.get('/standalone-search-url', handleGetStandaloneSearchUrl);

router.get('/:id', handleGetBatch);

// Batch generation (manual)
router.post('/generate', handleGenerateBatches);

// Search file download
router.get('/:id/search-url', handleGetSearchUrl);

// CKYC portal upload confirmation
router.post('/:id/confirm-upload', handleConfirmUpload);

// Response file upload flow
router.get('/:id/response-upload-url', handleGetResponseUploadUrl);
router.post('/:id/process-response',   handleProcessResponse);

// Final file download
router.get('/:id/final-urls', handleGetFinalUrls);

// Standalone bulk upload generation
router.post('/generate-upload', handleGenerateUpload);

// Standalone search generation (async)
router.post('/generate-search-standalone', handleGenerateSearchStandalone);

module.exports = router;
