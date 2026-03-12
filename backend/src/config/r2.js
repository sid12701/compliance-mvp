// backend/src/config/r2.js
'use strict';

const { S3Client } = require('@aws-sdk/client-s3');
const config       = require('./env');

// ── R2 Client ────────────────────────────────────────────────────
// AWS S3 SDK pointed at Cloudflare R2's S3-compatible endpoint.
//
// Critical settings:
//   endpoint        — R2's URL, not AWS's
//   region: 'auto'  — R2 doesn't use AWS regions
//   forcePathStyle  — R2 requires path-style URLs (not subdomain-style)
const r2Client = new S3Client({
  endpoint:          config.r2.publicEndpoint,
  region:            'auto',
  forcePathStyle:    true,
  credentials: {
    accessKeyId:     config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});

module.exports = { r2Client };