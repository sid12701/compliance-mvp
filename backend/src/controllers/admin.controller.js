'use strict';

const { AppError, ERROR_CODES } = require('../constants/errorCodes');
const adminService              = require('../services/admin.service');

// ── GET /api/v1/admin/users ───────────────────────────────────
async function handleListUsers(req, res, next) {
  try {
    const users = await adminService.listUsers();
    res.status(200).json({ success: true, data: { users } });
  } catch (err) { next(err); }
}

// ── POST /api/v1/admin/users ──────────────────────────────────
async function handleCreateUser(req, res, next) {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      throw new AppError(
        'username and password are required.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const user = await adminService.createUser({
      username,
      password,
      role:      role || 'operator',
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, data: { user } });
  } catch (err) { next(err); }
}

// ── PATCH /api/v1/admin/users/:id ────────────────────────────
async function handleUpdateUser(req, res, next) {
  try {
    const { password, role, is_active } = req.body;

    if (!password && role === undefined && is_active === undefined) {
      throw new AppError(
        'Provide at least one of: password, role, is_active.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    // Prevent dev from deactivating themselves
    if (req.params.id === req.user.id && is_active === false) {
      throw new AppError(
        'You cannot deactivate your own account.',
        400,
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const user = await adminService.updateUser({
      userId:    req.params.id,
      password,
      role,
      is_active,
      updatedBy: req.user.id,
    });

    res.status(200).json({ success: true, data: { user } });
  } catch (err) { next(err); }
}

module.exports = {
  handleListUsers,
  handleCreateUser,
  handleUpdateUser,
};
