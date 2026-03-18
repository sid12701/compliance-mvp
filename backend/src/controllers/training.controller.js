'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const trainingService = require('../services/training.service');
const r2Service = require('../services/r2.service');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const config = require('../config/env');

async function authenticateFromToken(token) {
  if (!token) {
    throw new AppError(
      'Authentication required. No Authorization header provided.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (jwtErr) {
    throw new AppError(
      jwtErr.name === 'TokenExpiredError'
        ? 'Authentication token has expired. Please log in again.'
        : 'Invalid authentication token.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  if (!decoded.jti) {
    throw new AppError(
      'Invalid token format - missing jti claim.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  const blacklistResult = await pool.query(
    `SELECT 1 FROM token_blacklist WHERE jti = $1`,
    [decoded.jti]
  );

  if (blacklistResult.rows.length > 0) {
    throw new AppError(
      'Token has been invalidated. Please log in again.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  const userResult = await pool.query(
    `SELECT id, username, role, is_active
     FROM users
     WHERE id = $1`,
    [decoded.sub]
  );

  if (userResult.rows.length === 0) {
    throw new AppError(
      'User account not found.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  const user = userResult.rows[0];
  if (!user.is_active) {
    throw new AppError(
      'User account has been deactivated. Please contact your administrator.',
      401,
      ERROR_CODES.UNAUTHORIZED
    );
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

async function handleListTrainingVideos(req, res, next) {
  try {
    const videos = await trainingService.listTrainingVideos();
    res.status(200).json({ success: true, data: { videos } });
  } catch (err) {
    next(err);
  }
}

async function handleStreamTrainingVideo(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;
    const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
    await authenticateFromToken(headerToken || queryToken);

    const { id } = req.params;
    const videos = await trainingService.listTrainingVideos();
    const video = videos.find((v) => v.id === id);

    if (!video) {
      throw new AppError('Training video not found.', 404, ERROR_CODES.NOT_FOUND);
    }

    const range = req.headers.range;
    const { stream, contentType, contentLength, contentRange, acceptRanges } =
      await r2Service.getObjectStream(video.r2_key, range);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', acceptRanges || 'bytes');

    if (contentRange) {
      res.status(206);
      res.setHeader('Content-Range', contentRange);
      if (contentLength) res.setHeader('Content-Length', contentLength);
    } else {
      if (contentLength) res.setHeader('Content-Length', contentLength);
    }

    if (stream && typeof stream.pipe === 'function') {
      stream.pipe(res);
      stream.on('error', next);
      req.on('close', () => {
        if (typeof stream.destroy === 'function') stream.destroy();
      });
    } else {
      res.status(500).json({
        success: false,
        error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Invalid stream.' },
      });
    }
  } catch (err) {
    next(err);
  }
}

module.exports = {
  handleListTrainingVideos,
  handleStreamTrainingVideo,
};
