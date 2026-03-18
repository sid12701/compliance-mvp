'use strict';

// Static training video catalog.
// Upload files directly to R2 under: ckyc/training/<filename>
// Then add entries here.
const TRAINING_VIDEOS = [
  {
    id: 'ckyc-intro',
    title: 'CKYC Platform Overview',
    description: 'Daily batch flow and downloads.',
    r2_key: 'ckyc/training/demo.mkv',
    filename: 'demo.mkv',
  },
];

module.exports = { TRAINING_VIDEOS };
