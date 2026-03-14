'use strict';

const express            = require('express');
const { authenticate }   = require('../middleware/authenticate');
const { requireRole }    = require('../middleware/requireRole');
const {
  handleListUsers,
  handleCreateUser,
  handleUpdateUser,
  handleListAuditLogs,
} = require('../controllers/admin.controller');

const router = express.Router();

router.use(authenticate);
router.use(requireRole('dev'));

// ── Users ─────────────────────────────────────────────────────
router.get('/users',        handleListUsers);
router.post('/users',       handleCreateUser);
router.patch('/users/:id',  handleUpdateUser);

// ── Audit logs ────────────────────────────────────────────────
router.get('/audit-logs',   handleListAuditLogs);

module.exports = router;