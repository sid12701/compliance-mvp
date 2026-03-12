// backend/src/services/email.service.js
'use strict';

const { Resend }              = require('resend');
const config                  = require('../config/env');
const { formatISTTimestamp }  = require('../utils/istTime');

// ── Resend client ─────────────────────────────────────────────────
// Instantiated once — the Resend SDK handles connection pooling internally.
const resend = new Resend(config.email.resendApiKey);

// ── Send generated alert ──────────────────────────────────────────
// Called by searchGen.worker.js after GENERATED status is set.
// Tells ops the search file is ready to download from the dashboard.
//
// Parameters:
//   targetDate    — 'YYYY-MM-DD' string
//   batchSequence — integer
//   recordCount   — number of PANs in the file
//   batchId       — UUID (for direct dashboard link)

async function sendGeneratedAlert({ targetDate, batchSequence, recordCount, batchId }) {
  const seq         = String(batchSequence).padStart(5, '0');
  const displayDate = _formatDisplayDate(targetDate);
  const timestamp   = formatISTTimestamp(new Date());
  const dashboardUrl = `${config.cors.frontendUrl}/batches/${batchId}`;

  const subject = `[CKYC] Search file ready — ${displayDate} (S${seq})`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #16a34a; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: white; margin: 0;">✓ Search File Ready</h2>
      </div>
      <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="color: #111827; font-size: 16px; margin-top: 0;">
          The CKYC search file for <strong>${displayDate}</strong> has been generated successfully.
        </p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #6b7280; width: 40%;">Batch Date</td>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #111827; font-weight: bold;">${displayDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #6b7280;">Sequence</td>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #111827;">S${seq}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #6b7280;">PAN Records</td>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #111827;">${recordCount}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #6b7280;">Generated At</td>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #111827;">${timestamp}</td>
          </tr>
        </table>

        <div style="margin: 24px 0; text-align: center;">
          <a href="${dashboardUrl}"
             style="background: #2563eb; color: white; padding: 12px 32px;
                    border-radius: 6px; text-decoration: none; font-size: 15px;
                    font-weight: bold; display: inline-block;">
            Open Dashboard →
          </a>
        </div>

        <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
          Next steps: Download the search file, upload it to the CKYC portal,
          then confirm the upload in the dashboard.
        </p>
      </div>
    </div>
  `;

  return _sendEmail({ subject, html });
}

// ── Send failed alert ─────────────────────────────────────────────
// Called by all four workers when batch → FAILED.
// Tells ops which batch failed, at which stage, and why.
//
// Parameters:
//   targetDate    — 'YYYY-MM-DD' string
//   batchSequence — integer
//   stage         — 'search_generation' | 'response_analysis' |
//                   'bulk_download' | 'upload_generation'
//   errorMessage  — already PAN-sanitized string (done in worker before calling)
//   batchId       — UUID

async function sendFailedAlert({ targetDate, batchSequence, stage, errorMessage, batchId }) {
  const seq         = String(batchSequence).padStart(5, '0');
  const displayDate = _formatDisplayDate(targetDate);
  const timestamp   = formatISTTimestamp(new Date());
  const dashboardUrl = `${config.cors.frontendUrl}/batches/${batchId}`;

  const stageLabels = {
    search_generation:  'Search File Generation',
    response_analysis:  'Response File Analysis',
    bulk_download:      'Bulk Download Generation',
    upload_generation:  'Upload File Generation',
  };
  const stageLabel = stageLabels[stage] || stage;

  const subject = `[CKYC] ⚠ Batch failed — ${displayDate} (S${seq})`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #dc2626; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: white; margin: 0;">⚠ Batch Processing Failed</h2>
      </div>
      <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="color: #111827; font-size: 16px; margin-top: 0;">
          The CKYC batch for <strong>${displayDate}</strong> failed
          during <strong>${stageLabel}</strong>.
        </p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #6b7280; width: 40%;">Batch Date</td>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #111827; font-weight: bold;">${displayDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #6b7280;">Sequence</td>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #111827;">S${seq}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #6b7280;">Failed Stage</td>
            <td style="padding: 8px 12px; background: #fff; border: 1px solid #e5e7eb; color: #dc2626; font-weight: bold;">${stageLabel}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #6b7280;">Failed At</td>
            <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; color: #111827;">${timestamp}</td>
          </tr>
        </table>

        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
          <p style="color: #991b1b; font-size: 13px; font-family: monospace; margin: 0; word-break: break-word;">
            ${errorMessage}
          </p>
        </div>

        <div style="margin: 24px 0; text-align: center;">
          <a href="${dashboardUrl}"
             style="background: #2563eb; color: white; padding: 12px 32px;
                    border-radius: 6px; text-decoration: none; font-size: 15px;
                    font-weight: bold; display: inline-block;">
            View & Re-trigger →
          </a>
        </div>

        <p style="color: #6b7280; font-size: 13px; margin-bottom: 0;">
          To retry this batch, open the dashboard, select the failed date,
          and use the manual generation option.
        </p>
      </div>
    </div>
  `;

  return _sendEmail({ subject, html });
}

// ── Internal send helper ──────────────────────────────────────────
// All emails go to the single ops recipient from config.
// Fire-and-forget — never throws, logs failures as WARN.

async function _sendEmail({ subject, html }) {
  try {
    const result = await resend.emails.send({
      from:    config.email.fromAddress,
      to:      config.email.opsRecipient,
      subject,
      html,
    });

    console.log(JSON.stringify({
      level:     'INFO',
      timestamp: new Date().toISOString(),
      message:   'Email sent',
      subject,
      messageId: result?.data?.id,
    }));

    return { sent: true, messageId: result?.data?.id };

  } catch (err) {
    console.warn(JSON.stringify({
      level:     'WARN',
      timestamp: new Date().toISOString(),
      message:   'Email send failed — continuing',
      subject,
      error:     err.message,
    }));
    return { sent: false, error: err.message };
  }
}

// ── Date display helper ───────────────────────────────────────────
// Converts 'YYYY-MM-DD' to '09 Mar 2026' for email readability
function _formatDisplayDate(dateStr) {
  const months = [
    'Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'
  ];
  const [year, month, day] = dateStr.split('-');
  return `${day} ${months[parseInt(month, 10) - 1]} ${year}`;
}

module.exports = { sendGeneratedAlert, sendFailedAlert };