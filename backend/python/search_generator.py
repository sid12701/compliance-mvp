#!/usr/bin/env python3
# backend/python/search_generator.py
#
# Merged pan_extractor.py + bulk-search.py
#
# Reads from stdin (JSON):
#   {
#     "target_date":    "2026-03-09",      ← YYYY-MM-DD from Node.js
#     "batch_sequence": 16,
#     "r2_output_key":  "ckyc/09-03-2026/search/IN3860_09032026_V1.1_S00016.txt"
#   }
#
# Writes to stdout on success (JSON):
#   {
#     "success":        true,
#     "record_count":   187,
#     "r2_key_written": "ckyc/09-03-2026/search/IN3860_09032026_V1.1_S00016.txt"
#   }
#
# Writes to stdout on failure (JSON):
#   {
#     "success": false,
#     "error":   "Human readable error message"
#   }
#
# ALL diagnostic logging goes to stderr — stdout is reserved for
# the single JSON result line that Node.js reads.

from __future__ import annotations

import imaplib
import email
import re
import sys
import os
import json
import logging
import io
from datetime import datetime, timedelta
from email.header import decode_header

import boto3
from botocore.config import Config

# ════════════════════════════════════════════════════════════════════
# LOGGING — stderr only, never stdout
# ════════════════════════════════════════════════════════════════════

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════
# CONFIGURATION — from environment, never hardcoded
# ════════════════════════════════════════════════════════════════════

IMAP_SERVER   = "imap.gmail.com"

# Gmail credentials — injected by Node.js via process.env
EMAIL_USER    = os.environ.get('GMAIL_ADDRESS')
EMAIL_PASS    = os.environ.get('GMAIL_APP_PASSWORD')

# R2 credentials — same env vars used by the Node.js r2.service.js
R2_ACCOUNT_ID        = os.environ.get('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID     = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME       = os.environ.get('R2_BUCKET_NAME')
R2_PUBLIC_ENDPOINT   = os.environ.get('R2_PUBLIC_ENDPOINT')

# CKYC file format constants — keep identical to original bulk-search.py
FI_CODE  = "IN3860"
REGION   = "IT"
VERSION  = "1.1"

# PAN format: 5 uppercase letters + 4 digits + 1 uppercase letter
PAN_REGEX = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")

# ════════════════════════════════════════════════════════════════════
# PART 1 — PAN EXTRACTION (from pan_extractor.py, unchanged logic)
# ════════════════════════════════════════════════════════════════════

def _get_imap_date_range(year: int, month: int, day: int):
    """
    Returns (since_date, before_date) as IMAP-formatted strings.
    Always daily mode — target_date gives us year/month/day.
    """
    start_date = datetime(year, month, day)
    end_date   = start_date + timedelta(days=1)
    return start_date.strftime("%d-%b-%Y"), end_date.strftime("%d-%b-%Y")


def _clean_text(raw_bytes: bytes) -> str:
    """Decodes bytes to string and strips HTML tags."""
    try:
        text = raw_bytes.decode('utf-8', errors='ignore')
    except Exception:
        return ""
    # Strip HTML tags — identical to original
    text = re.sub('<[^<]+?>', ' ', text)
    return text


def _extract_pans_from_msg(msg) -> set:
    """
    Extracts all PAN-like strings from an email message.
    Checks subject line + all text body parts.
    Logic identical to original pan_extractor.py.
    """
    found = set()

    # 1. Check Subject
    subject_val = msg.get("Subject", "")
    if subject_val:
        decoded_list = decode_header(subject_val)
        subject_str  = ""
        for content, encoding in decoded_list:
            if isinstance(content, bytes):
                subject_str += content.decode(encoding or 'utf-8', errors='ignore')
            else:
                subject_str += str(content)
        found.update(PAN_REGEX.findall(subject_str))

    # 2. Check Body — walk all parts
    if msg.is_multipart():
        for part in msg.walk():
            try:
                if part.get_content_maintype() == 'text':
                    payload = part.get_payload(decode=True)
                    if payload:
                        text = _clean_text(payload)
                        found.update(PAN_REGEX.findall(text))
            except Exception:
                continue
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                text = _clean_text(payload)
                found.update(PAN_REGEX.findall(text))
        except Exception:
            pass

    return found


def fetch_pans(year: int, month: int, day: int) -> list[str]:
    """
    Connects to Gmail via IMAP, searches emails for target date,
    extracts all PAN numbers. Returns sorted, deduplicated list.
    Raises on login failure or IMAP error.
    """
    if not EMAIL_USER or not EMAIL_PASS:
        raise RuntimeError(
            "GMAIL_ADDRESS and GMAIL_APP_PASSWORD environment variables must be set."
        )

    log.info(f"Connecting to {IMAP_SERVER} as {EMAIL_USER}...")
    try:
        mail = imaplib.IMAP4_SSL(IMAP_SERVER)
        mail.login(EMAIL_USER, EMAIL_PASS)
    except Exception as e:
        raise RuntimeError(f"Gmail login failed: {e}") from e

    try:
        mail.select("inbox")

        since_date, before_date = _get_imap_date_range(year, month, day)
        search_criteria = f'(SINCE "{since_date}" BEFORE "{before_date}")'

        log.info(f"Searching emails: {search_criteria}")
        status, messages = mail.search(None, search_criteria)

        if status != "OK":
            raise RuntimeError(f"IMAP search failed with status: {status}")

        email_ids   = messages[0].split()
        total_emails = len(email_ids)

        if total_emails == 0:
            log.info("No emails found for this date range.")
            return []

        log.info(f"Found {total_emails} email(s). Extracting PANs...")

        all_pans = set()

        for i, eid in enumerate(email_ids, 1):
            log.info(f"Scanning email {i}/{total_emails}...")
            try:
                # Fetch first 50KB of body — identical to original
                _, data = mail.fetch(eid, '(BODY.PEEK[]<0.50000>)')
                if data and data[0]:
                    raw_email = data[0][1]
                    msg       = email.message_from_bytes(raw_email)
                    pans      = _extract_pans_from_msg(msg)
                    if pans:
                        all_pans.update(pans)
            except Exception as e:
                log.warning(f"Failed to parse email {eid}: {e}")
                continue

    finally:
        # Always close the IMAP connection
        try:
            mail.close()
            mail.logout()
        except Exception:
            pass

    # Deduplicate and validate — identical to original
    valid_pans = [p for p in all_pans if re.match(r"^[A-Z]{5}[0-9]{4}[A-Z]$", p)]
    result     = sorted(valid_pans)

    log.info(f"Extraction complete. {len(result)} unique valid PAN(s) found.")
    return result


# ════════════════════════════════════════════════════════════════════
# PART 2 — FILE FORMATTING (from bulk-search.py, unchanged logic)
# ════════════════════════════════════════════════════════════════════

def _normalize_version(v: str) -> str:
    v = str(v).strip()
    return v if v.upper().startswith("V") else f"V{v}"


def _write_header_line(fi_code: str, region: str, total_records: int,
                        version: str, date_str: str) -> str:
    """
    Type 10 Header line.
    Format: 10|FI|REG|COUNT|VER|DATE||||
    Identical to original bulk-search.py write_header_line().
    """
    return "|".join([
        "10",
        fi_code,
        region,
        str(total_records),
        _normalize_version(version),
        date_str,
        "", "", "", ""   # 4 empty strings → |||| at end
    ])


def _write_detail_line(seq: int, pan: str) -> str:
    """
    Type 20 Detail line.
    Format: 20|SEQ|C|PAN||||
    Identical to original bulk-search.py write_detail_line().
    """
    return "|".join([
        "20",
        str(seq),
        "C",
        pan,
        "", "", "", ""   # 4 empty strings → |||| at end
    ])


def build_ckyc_file_bytes(pans: list[str], date_str: str) -> bytes:
    """
    Formats PANs into the CKYC pipe-delimited file format.
    Returns the complete file as bytes with CRLF line endings.

    The output is IDENTICAL to what bulk-search.py writes to disk —
    same header, same detail lines, same CRLF endings.
    Instead of writing to disk we return bytes for R2 upload.
    """
    # Deduplicate while preserving sort order
    seen       = set()
    unique_pans = []
    for p in pans:
        if p not in seen:
            seen.add(p)
            unique_pans.append(p)

    if not unique_pans:
        raise ValueError("No valid PANs to write — cannot generate empty CKYC file.")

    lines = []

    # Header line (Type 10)
    lines.append(_write_header_line(FI_CODE, REGION, len(unique_pans), VERSION, date_str))

    # Detail lines (Type 20) — one per PAN
    for i, pan in enumerate(unique_pans, 1):
        lines.append(_write_detail_line(i, pan))

    # Join with CRLF — identical to original newline="\r\n" file open
    content = "\r\n".join(lines) + "\r\n"

    return content.encode('utf-8')


# ════════════════════════════════════════════════════════════════════
# PART 3 — R2 UPLOAD (replaces local disk write)
# ════════════════════════════════════════════════════════════════════

def upload_to_r2(file_bytes: bytes, r2_key: str) -> None:
    """
    Uploads file_bytes to Cloudflare R2 at the given key.
    Uses the same R2 credentials as Node.js r2.service.js.
    Raises on any upload failure.
    """
    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
                R2_BUCKET_NAME, R2_PUBLIC_ENDPOINT]):
        raise RuntimeError(
            "One or more R2 environment variables are missing: "
            "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, "
            "R2_BUCKET_NAME, R2_PUBLIC_ENDPOINT"
        )

    log.info(f"Uploading {len(file_bytes)} bytes to R2: {r2_key}")

    s3_client = boto3.client(
        's3',
        endpoint_url          = R2_PUBLIC_ENDPOINT,
        aws_access_key_id     = R2_ACCESS_KEY_ID,
        aws_secret_access_key = R2_SECRET_ACCESS_KEY,
        region_name           = 'auto',
        config                = Config(signature_version='s3v4'),
    )

    s3_client.put_object(
        Bucket      = R2_BUCKET_NAME,
        Key         = r2_key,
        Body        = file_bytes,
        ContentType = 'text/plain',
    )

    log.info(f"Upload complete: {r2_key}")


# ════════════════════════════════════════════════════════════════════
# MAIN — stdin → extract → format → upload → stdout
# ════════════════════════════════════════════════════════════════════

def main():
    # ── Read payload from stdin ───────────────────────────────────
    try:
        raw_input = sys.stdin.read()
        payload   = json.loads(raw_input)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to parse stdin JSON: {e}"}))
        sys.exit(1)

    target_date    = payload.get('target_date')    # "2026-03-09"
    batch_sequence = payload.get('batch_sequence') # 16
    r2_output_key  = payload.get('r2_output_key')  # full R2 key string

    # ── Validate required fields ──────────────────────────────────
    if not target_date or not batch_sequence or not r2_output_key:
        print(json.dumps({
            "success": False,
            "error":   "stdin payload missing required fields: target_date, batch_sequence, r2_output_key"
        }))
        sys.exit(1)

    # ── Parse target_date ─────────────────────────────────────────
    # Node.js sends YYYY-MM-DD — convert to year/month/day ints
    try:
        dt    = datetime.strptime(target_date, "%Y-%m-%d")
        year  = dt.year
        month = dt.month
        day   = dt.day
    except ValueError as e:
        print(json.dumps({"success": False, "error": f"Invalid target_date format: {e}"}))
        sys.exit(1)

    # Date string for CKYC header line — DD-MM-YYYY format
    header_date_str = dt.strftime("%d-%m-%Y")

    log.info(f"search_generator.py started — target_date={target_date} batch_sequence={batch_sequence}")

    # ── Step 1: Fetch PANs from Gmail ─────────────────────────────
    try:
        pans = fetch_pans(year, month, day)
    except Exception as e:
        log.error(f"PAN extraction failed: {e}")
        print(json.dumps({"success": False, "error": f"PAN extraction failed: {e}"}))
        sys.exit(1)

    if not pans:
        log.info("No PANs found for this date — writing empty result.")
        print(json.dumps({
            "success":        False,
            "error":          f"No PANs found in emails for {target_date}. Verify emails exist for this date.",
        }))
        sys.exit(1)

    log.info(f"Extracted {len(pans)} unique PAN(s)")

    # ── Step 2: Format into CKYC file bytes ───────────────────────
    try:
        file_bytes = build_ckyc_file_bytes(pans, header_date_str)
    except Exception as e:
        log.error(f"File formatting failed: {e}")
        print(json.dumps({"success": False, "error": f"File formatting failed: {e}"}))
        sys.exit(1)

    log.info(f"CKYC file built — {len(file_bytes)} bytes, {len(pans)} records")

    # ── Step 3: Upload to R2 ──────────────────────────────────────
    try:
        upload_to_r2(file_bytes, r2_output_key)
    except Exception as e:
        log.error(f"R2 upload failed: {e}")
        print(json.dumps({"success": False, "error": f"R2 upload failed: {e}"}))
        sys.exit(1)

    # ── Step 4: Write success result to stdout ────────────────────
    result = {
        "success":        True,
        "record_count":   len(pans),
        "r2_key_written": r2_output_key,
    }

    log.info(f"search_generator.py complete — {len(pans)} records written to {r2_output_key}")

    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()