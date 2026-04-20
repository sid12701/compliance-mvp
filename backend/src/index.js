// backend/src/index.js
'use strict';

// ── Step 1: Validate all 22 env vars before anything else ─────────
// This must be the very first import. If any var is missing,
// process.exit(1) fires here before Express is even created.
const config = require('./config/env');

// ── Step 2: Core dependencies ─────────────────────────────────────
const express = require('express');
const { testConnection } = require('./config/database');

// ── Step 3: Middleware imports ────────────────────────────────────
const { attachRequestId } = require('./middleware/requestId');
const { errorHandler }    = require('./middleware/errorHandler');
const batchRoutes    = require('./routes/batches.routes');
const { startWorkers, shutdownWorkers } = require('./workers/index');


// ── Step 4: Route imports ─────────────────────────────────────────
const authRoutes     = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const trainingRoutes = require('./routes/training.routes');

// These will be added in later phases:
// ── Create Express app ────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);
// ════════════════════════════════════════════════════════════════════
// MIDDLEWARE STACK
// Order is critical — these run top-to-bottom on every request.
// ════════════════════════════════════════════════════════════════════

// 1. Request ID — must be first so every subsequent log line
//    can include the requestId for tracing.
app.use(attachRequestId);

// 2. JSON body parser — parses Content-Type: application/json
//    req.body is undefined without this.
//    limit: '10mb' covers the largest expected request body
//    (Response file confirmation, not the file itself — that goes to R2 directly).
app.use(express.json({ limit: '10mb' }));

// 3. CORS — allows the Cloudflare Pages frontend to call this API.
//    Without this, browsers block cross-origin requests entirely.
app.use((req, res, next) => {
  const allowedOrigin = config.cors.frontendUrl;
  const origin = req.headers.origin;

  // Allow requests from the configured frontend URL
  // and allow requests with no origin (e.g. Render health checks, curl)
  if (!origin || origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // OPTIONS is the browser's preflight request — respond immediately
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

// 4. Request logging — logs every inbound request with method, path,
//    and eventually the response status and time.
//    Simple but sufficient for MVP — replace with a proper logger in post-MVP.
app.use((req, res, next) => {
  const start = Date.now();

  // Log when the response finishes (not when request arrives)
  // so we can include the status code and response time.
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level    = res.statusCode >= 500 ? 'ERROR'
                   : res.statusCode >= 400 ? 'WARN'
                   : 'INFO';
    console.log(JSON.stringify({
      level,
      timestamp:  new Date().toISOString(),
      requestId:  req.requestId,
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      duration_ms: duration,
      ip:         req.ip,
    }));
  });

  next();
});

// ════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════

// Health check — no auth required.
// Render uses this to verify the service is alive.
app.get('/health', async (req, res) => {
  try {
    // Verify DB is reachable as part of the health check
    const { pool } = require('./config/database');
    await pool.query('SELECT 1');
    res.status(200).json({
      success: true,
      data: {
        status:    'healthy',
        timestamp: new Date().toISOString(),
        env:       config.server.nodeEnv,
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: {
        code:    'SERVICE_UNAVAILABLE',
        message: 'Database connection failed.',
      },
    });
  }
});

// Versioned API routes
app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/batches',   batchRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/training', trainingRoutes);

// 404 handler — catches any route that did not match above
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code:    'INVALID_REQUEST',
      message: `Route ${req.method} ${req.path} not found.`,
    },
  });
});

// Global error handler — MUST be last, MUST have 4 parameters.
// Express identifies error handlers by the (err, req, res, next) signature.
app.use(errorHandler);

// ════════════════════════════════════════════════════════════════════
// SERVER START
// ════════════════════════════════════════════════════════════════════

async function start() {
  try {
    await testConnection();

    const port = config.server.port;
    app.listen(port, () => {
      console.log(JSON.stringify({
        level:     'INFO',
        timestamp: new Date().toISOString(),
        message:   'CKYC Platform backend running',
        port,
        env:       config.server.nodeEnv,
      }));

      // Start BullMQ workers only when explicitly enabled
      if (config.workers.enabled) {
        startWorkers();
      } else {
        console.log(JSON.stringify({
          level:     'INFO',
          timestamp: new Date().toISOString(),
          message:   'Workers disabled (WORKERS_ENABLED=false)',
        }));
      }
    });

    // ── Graceful shutdown ────────────────────────────────────
    // Render sends SIGTERM before killing the process on deploy/restart
    // We wait for in-progress jobs to finish before exiting
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received — shutting down gracefully');
      await shutdownWorkers();
      process.exit(0);
    });

  } catch (err) {
    console.error('FATAL: Server failed to start:', err.message);
    process.exit(1);
  }
}




start();

module.exports = app; // exported for testing
