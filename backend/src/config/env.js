// backend/src/config/env.js
'use strict';

// Load .env file for local development.
// On Render, env vars are injected by the platform — dotenv is a no-op.
require('dotenv').config();

// ── All 22 required environment variables ────────────────────────
const REQUIRED_VARS = [
  // Server
  'NODE_ENV',
  'PORT',
  // Database
  'DATABASE_URL',
  // Redis
  'REDIS_URL',
  // Auth
  'JWT_SECRET',
  'JWT_EXPIRY',
  // CRON
  'CRON_TRIGGER_SECRET',
  'CRON_TIMEZONE',
  'CRON_SCHEDULE',
  // R2
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_ENDPOINT',
  // Email
  'RESEND_API_KEY',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_OPS_RECIPIENT',
  // Gmail (read by Python — but must exist in env so Python can access them)
  'GMAIL_ADDRESS',
  'GMAIL_APP_PASSWORD',
  // Python
  'PYTHON_SCRIPT_PATH',
  'PYTHON_TIMEOUT_MS',
  // CORS
  'FRONTEND_URL',
];

// ── Validate ─────────────────────────────────────────────────────
const missing = REQUIRED_VARS.filter(
  (key) => !process.env[key] || process.env[key].trim() === ''
);

if (missing.length > 0) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║  STARTUP FAILED — Missing environment variables  ║');
  console.error('╚══════════════════════════════════════════════════╝');
  console.error('');
  console.error('The following required variables are not set:');
  missing.forEach((key) => console.error(`  ✗  ${key}`));
  console.error('');
  console.error('See backend/.env.example for setup instructions.');
  console.error('');
  process.exit(1);
}

// ── Export structured, frozen config ─────────────────────────────
// The rest of the app imports THIS object — never process.env directly.
const config = Object.freeze({
  server: {
    nodeEnv:     process.env.NODE_ENV,
    port:        parseInt(process.env.PORT, 10),
    isProduction: process.env.NODE_ENV === 'production',
  },
  db: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  jwt: {
    secret:   process.env.JWT_SECRET,
    expiry:   process.env.JWT_EXPIRY,
  },
  cron: {
    secret:   process.env.CRON_TRIGGER_SECRET,
    timezone: process.env.CRON_TIMEZONE,
    schedule: process.env.CRON_SCHEDULE,
  },
  r2: {
    accountId:       process.env.R2_ACCOUNT_ID,
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName:      process.env.R2_BUCKET_NAME,
    publicEndpoint:  process.env.R2_PUBLIC_ENDPOINT,
  },
  email: {
    resendApiKey:  process.env.RESEND_API_KEY,
    fromAddress:   process.env.EMAIL_FROM_ADDRESS,
    opsRecipient:  process.env.EMAIL_OPS_RECIPIENT,
  },
  gmail: {
    address:     process.env.GMAIL_ADDRESS,
    appPassword: process.env.GMAIL_APP_PASSWORD,
  },
  python: {
    scriptPath:  process.env.PYTHON_SCRIPT_PATH,
    timeoutMs:   parseInt(process.env.PYTHON_TIMEOUT_MS, 10),
  },
  cors: {
    frontendUrl: process.env.FRONTEND_URL,
  },
});

module.exports = config;