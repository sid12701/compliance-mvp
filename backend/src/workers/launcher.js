'use strict';

const { spawn }   = require('child_process');
const { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } = require('fs');
const { join }    = require('path');
const { tmpdir }  = require('os');
const config      = require('../config/env');

const PID_DIR  = join(tmpdir(), 'ckyc-workers');
const PID_FILE = join(PID_DIR, 'workers.pid');

let _spawning = false;

function _isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function _readPid() {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(raw, 10);
  return Number.isNaN(pid) ? null : pid;
}

function _writePid(pid) {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), 'utf8');
}

function _clearPid() {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

function ensureWorkersRunning() {
  if (config.workers.enabled) {
    return;
  }

  if (_spawning) return;
  _spawning = true;

  try {
    const existingPid = _readPid();
    if (existingPid && _isProcessAlive(existingPid)) {
      return;
    }

    _clearPid();

    const workerScript = join(__dirname, 'runner.js');
    const child = spawn(
      process.execPath,
      [workerScript],
      {
        env: {
          ...process.env,
          WORKERS_ENABLED: 'true',
          WORKERS_ON_DEMAND: 'true',
        },
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }
    );

    _writePid(child.pid);
    child.unref();
  } finally {
    _spawning = false;
  }
}

module.exports = { ensureWorkersRunning };
