'use strict';

const { TRAINING_VIDEOS } = require('../config/trainingVideos');

function listTrainingVideos() {
  if (!Array.isArray(TRAINING_VIDEOS) || TRAINING_VIDEOS.length === 0) {
    return [];
  }
  return TRAINING_VIDEOS;
}

module.exports = {
  listTrainingVideos,
};
