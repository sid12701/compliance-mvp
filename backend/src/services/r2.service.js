'use strict';

const {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
}                        = require('@aws-sdk/client-s3');
const { getSignedUrl }   = require('@aws-sdk/s3-request-presigner');
const { r2Client }       = require('../config/r2');
const config             = require('../config/env');
const { AppError,
        ERROR_CODES }    = require('../constants/errorCodes');
const { validateKey }    = require('../utils/r2Paths');

const BUCKET             = config.r2.bucketName;
const PRESIGNED_EXPIRY   = 15 * 60; // 15 minutes in seconds

// ── Presigned download URL ────────────────────────────────────────
// Generates a temporary URL that lets the browser download a file
// directly from R2 without going through the Node.js server.
//
// The downloadFilename sets the Content-Disposition header so the
// browser saves the file with the correct CKYC filename convention
// rather than the raw R2 key.
async function getPresignedDownloadUrl(key, downloadFilename) {
  validateKey(key);

  const command = new GetObjectCommand({
    Bucket:                     BUCKET,
    Key:                        key,
    ResponseContentDisposition: `attachment; filename="${downloadFilename}"`,
  });

  try {
    const url       = await getSignedUrl(r2Client, command, { expiresIn: PRESIGNED_EXPIRY });
    const expiresAt = new Date(Date.now() + PRESIGNED_EXPIRY * 1000).toISOString();
    return { url, expiresAt };
  } catch (err) {
    console.error(`[R2] getPresignedDownloadUrl failed for key "${key}":`, err.message);
    throw new AppError(
      'Failed to generate download URL. Storage service may be unavailable.',
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE
    );
  }
}

// ── Presigned upload URL ──────────────────────────────────────────
// Generates a temporary URL that lets the browser PUT a file
// directly into R2. The file bytes never pass through Node.js.
// Used for the Response file upload flow.
async function getPresignedUploadUrl(key, contentType = 'text/plain') {
  validateKey(key);

  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    ContentType: contentType,
  });

  try {
    const url       = await getSignedUrl(r2Client, command, { expiresIn: PRESIGNED_EXPIRY });
    const expiresAt = new Date(Date.now() + PRESIGNED_EXPIRY * 1000).toISOString();
    return { url, expiresAt };
  } catch (err) {
    console.error(`[R2] getPresignedUploadUrl failed for key "${key}":`, err.message);
    throw new AppError(
      'Failed to generate upload URL. Storage service may be unavailable.',
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE
    );
  }
}

// ── File existence check ──────────────────────────────────────────
// Uses HeadObject — fetches metadata only, not file contents.
// Returns { exists, size, lastModified } so callers can use
// file size for audit logging without a separate download.
async function fileExists(key) {
  validateKey(key);

  try {
    const command = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
    const result  = await r2Client.send(command);
    return {
      exists:       true,
      size:         result.ContentLength  || 0,
      lastModified: result.LastModified   || null,
    };
  } catch (err) {
    // 404 from R2 = file does not exist — this is not an error condition
    const statusCode = err.$metadata?.httpStatusCode;
    if (statusCode === 404 || err.name === 'NotFound') {
      return { exists: false, size: null, lastModified: null };
    }
    console.error(`[R2] fileExists failed for key "${key}":`, err.message);
    throw new AppError(
      'Failed to check file existence. Storage service may be unavailable.',
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE
    );
  }
}

// ── Direct upload (used by workers, not browser) ──────────────────
// Python scripts upload to R2 via boto3 directly.
// This function is used by Node.js workers only when Node.js
// itself needs to write a file (not common in this architecture).
async function putObject(key, body, contentType = 'application/octet-stream') {
  validateKey(key);

  try {
    const command = new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        body,
      ContentType: contentType,
    });
    await r2Client.send(command);
    return { key };
  } catch (err) {
    console.error(`[R2] putObject failed for key "${key}":`, err.message);
    throw new AppError(
      `Failed to upload file to storage.`,
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE
    );
  }
}

// ── Fetch file as buffer ──────────────────────────────────────────
// Used by workers to fetch the Response file from R2 and pass its
// contents to Python via stdin (base64-encoded).
// Python never holds R2 credentials — Node.js fetches on its behalf.
async function getObject(key) {
  validateKey(key);

  try {
    const command  = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await r2Client.send(command);

    // R2 returns a ReadableStream — collect all chunks into a Buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404) {
      throw new AppError(
        `File not found in storage: ${key}`,
        404,
        ERROR_CODES.BATCH_NOT_FOUND
      );
    }
    console.error(`[R2] getObject failed for key "${key}":`, err.message);
    throw new AppError(
      `Failed to retrieve file from storage.`,
      503,
      ERROR_CODES.SERVICE_UNAVAILABLE
    );
  }
}

module.exports = {
  getPresignedDownloadUrl,
  getPresignedUploadUrl,
  fileExists,
  putObject,
  getObject,
};