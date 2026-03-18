'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const {
  handleListTrainingVideos,
  handleStreamTrainingVideo,
} = require('../controllers/training.controller');

const router = express.Router();

// Stream route accepts token via query param (video tag cannot send headers)
router.get('/:id/stream', handleStreamTrainingVideo);

router.use(authenticate);
router.get('/', handleListTrainingVideos);

module.exports = router;
