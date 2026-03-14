'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Unauthorized.', 401, ERROR_CODES.UNAUTHORIZED));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError(
        'You do not have permission to access this resource.',
        403,
        ERROR_CODES.FORBIDDEN
      ));
    }
    next();
  };
}

module.exports = { requireRole };