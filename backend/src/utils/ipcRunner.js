// backend/src/utils/ipcRunner.js
'use strict';

const { spawn }                          = require('child_process');
const { writeFileSync, unlinkSync,
        mkdirSync, existsSync }          = require('fs');
const { join }                           = require('path');
const { randomUUID }                     = require('crypto');
const { sanitizeStderr }                 = require('./panSanitizer');
const config                             = require('../config/env');

// ── Constants ─────────────────────────────────────────────────────
const TEMP_DIR         = '/tmp/ckyc_ipc';
const STDIN_SIZE_LIMIT = 64 * 1024; // 64KB — above this, use temp file

// ── Main IPC runner ───────────────────────────────────────────────
// Spawns a Python script, sends a JSON payload via stdin,
// and returns the parsed JSON stdout response.
//
// Parameters:
//   scriptName  — filename only e.g. 'search_generator.py'
//   payload     — plain JS object, will be JSON-serialised
//   requestId   — propagated from the HTTP request for log tracing
//
// Returns: parsed JSON object from Python's stdout
// Throws:  Error with sanitised message if Python exits non-zero,
//          times out, or stdout is not valid JSON

async function runPythonScript(scriptName, payload, requestId = 'system') {
  const scriptPath = join(config.python.scriptPath, scriptName);
  const timeoutMs  = config.python.timeoutMs;

  // Serialise payload to JSON bytes
  const payloadJson  = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');

  // Decide IPC mechanism based on payload size
  const useTempFile = payloadBytes > STDIN_SIZE_LIMIT;

  let tempFilePath = null;
  let stdinData    = payloadJson;

  // ── Temp file setup (>64KB payloads) ────────────────────────
  if (useTempFile) {
    if (!existsSync(TEMP_DIR)) {
      // 0700 = only owner can read/write/execute
      mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });
    }
    tempFilePath = join(TEMP_DIR, `${randomUUID()}.json`);
    // 0600 = only owner can read/write
    writeFileSync(tempFilePath, payloadJson, { mode: 0o600, encoding: 'utf8' });
    // Pass the file path via stdin instead of the raw payload
    stdinData = JSON.stringify({ __ipc_file: tempFilePath });
    console.log(
      `[IPC][${requestId}] Payload ${payloadBytes} bytes — using temp file: ${tempFilePath}`
    );
  } else {
    // Log byte count only — never log the payload contents (PII rule)
    console.log(
      `[IPC][${requestId}] Wrote ${payloadBytes} bytes to Python stdin`
    );
  }

  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut     = false;
    let settled      = false;

    // ── Spawn Python process ─────────────────────────────────
    // Script path is the only CLI argument.
    // Data never touches argv per the PII security rule.
    const child = spawn('python3', [scriptPath], {
      env: {
        ...process.env,    // Pass all env vars — Python reads GMAIL_* from here
        PYTHONUNBUFFERED: '1', // Force Python to flush stdout immediately
      },
      // Do NOT pass cwd or shell:true — keep the execution environment clean
    });

    // ── Timeout ──────────────────────────────────────────────
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(
          `Python script "${scriptName}" timed out after ${timeoutMs}ms`
        ));
      }
    }, timeoutMs);

    // ── Send payload via stdin ────────────────────────────────
    child.stdin.write(stdinData, 'utf8');
    child.stdin.end(); // Signal EOF to Python — sys.stdin.read() returns

    // ── Capture stdout ────────────────────────────────────────
    // This is the IPC response channel.
    // Only the final JSON result should be written here by Python.
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    // ── Capture stderr ────────────────────────────────────────
    // Python's logging output and tracebacks come here.
    // Sanitised before any use — PAN values are redacted.
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    // ── Process exit ──────────────────────────────────────────
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      cleanup();

      if (timedOut || settled) return;
      settled = true;

      // Always sanitise stderr regardless of success or failure
      const sanitizedStderr = sanitizeStderr(stderrBuffer);

      if (sanitizedStderr) {
        // Log stderr at appropriate level
        if (exitCode !== 0) {
          console.error(
            `[IPC][${requestId}] Python stderr (exit ${exitCode}):`,
            sanitizedStderr
          );
        } else {
          console.log(
            `[IPC][${requestId}] Python stderr (exit 0):`,
            sanitizedStderr
          );
        }
      }

      // Non-zero exit = Python script failed
      if (exitCode !== 0) {
        return reject(new Error(
          `Python script "${scriptName}" exited with code ${exitCode}. ` +
          `Stderr: ${sanitizedStderr}`
        ));
      }

      // Parse stdout as JSON
      const raw = stdoutBuffer.trim();
      if (!raw) {
        return reject(new Error(
          `Python script "${scriptName}" produced no stdout output`
        ));
      }

      let result;
      try {
        result = JSON.parse(raw);
      } catch (parseErr) {
        return reject(new Error(
          `Python script "${scriptName}" stdout is not valid JSON. ` +
          `Got: "${raw.substring(0, 100)}"`
        ));
      }

      // Python can signal a business-level failure via { success: false }
      // even with exit code 0 (e.g. no emails found for this date)
      if (result.success === false) {
        const err = new Error(
          result.error || `Python script "${scriptName}" reported failure`
        );
        err.pythonResult = result; // Attach full result for callers to inspect
        return reject(err);
      }

      resolve(result);
    });

    // ── Spawn error ───────────────────────────────────────────
    // Fires if Python is not installed or script path is wrong
    child.on('error', (spawnErr) => {
      clearTimeout(timer);
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(
          `Failed to spawn Python script "${scriptName}": ${spawnErr.message}`
        ));
      }
    });

    // ── Temp file cleanup ─────────────────────────────────────
    // Called unconditionally — whether Python succeeded, failed,
    // or timed out. The temp file must never be left on disk.
    function cleanup() {
      if (tempFilePath) {
        try {
          unlinkSync(tempFilePath);
        } catch (cleanupErr) {
          // Log but do not throw — cleanup failure is secondary to
          // reporting the actual script result
          console.error(
            `[IPC][${requestId}] Failed to delete temp file ${tempFilePath}:`,
            cleanupErr.message
          );
        }
      }
    }
  });
}

module.exports = { runPythonScript };