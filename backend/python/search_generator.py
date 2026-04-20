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
#     "r2_key_written": "ckyc/09-03-2026/search/IN3860_09032026_V1.1_S00016.txt",
#     "pan_dob_r2_key": "ckyc/09-03-2026/search/IN3860_09032026_V1.1_S00016_pan_dob.json"
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
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.header import decode_header
from html.parser import HTMLParser
from typing import Optional

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

EMAIL_USER    = os.environ.get('GMAIL_ADDRESS')
EMAIL_PASS    = os.environ.get('GMAIL_APP_PASSWORD')

R2_ACCOUNT_ID        = os.environ.get('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID     = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME       = os.environ.get('R2_BUCKET_NAME')
R2_PUBLIC_ENDPOINT   = os.environ.get('R2_PUBLIC_ENDPOINT')

FI_CODE  = "IN3860"
REGION   = "IT"
VERSION  = "1.1"

# PAN format: 5 uppercase letters + 4 digits + 1 uppercase letter
PAN_REGEX = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")

# Masked Aadhaar: xxxx xxxx 6088 / XXXX-XXXX-6088 / ****xxxx6088 etc.
AADHAAR_MASKED_REGEX = re.compile(
    r"\b[Xx\*]{4}[\s\-]?[Xx\*]{4}[\s\-]?\d{4}\b"
)

# Gender normalisation map — covers all reasonable email variations
_GENDER_MAP = {
    'male':        'M',
    'm':           'M',
    'female':      'F',
    'f':           'F',
    'transgender': 'T',
    't':           'T',
}


# ════════════════════════════════════════════════════════════════════
# DATA MODEL
# ════════════════════════════════════════════════════════════════════

@dataclass
class CustomerData:
    """All identity data extracted for one customer from an email."""
    pan:          str
    aadhaar_last4: Optional[str] = None   # last 4 digits only, e.g. "6088"
    name:         Optional[str] = None   # as it appears in the email
    dob:          Optional[str] = None   # DD-MM-YYYY
    gender:       Optional[str] = None   # M / F / T

    @property
    def has_aadhaar_line(self) -> bool:
        """True only when all three mandatory Aadhaar fields are present."""
        return bool(self.aadhaar_last4 and self.name and self.dob and self.gender)


# ════════════════════════════════════════════════════════════════════
# PART 1 — EXTRACTION
# ════════════════════════════════════════════════════════════════════

def _get_imap_date_range(year: int, month: int, day: int):
    start_date = datetime(year, month, day)
    end_date   = start_date + timedelta(days=1)
    return start_date.strftime("%d-%b-%Y"), end_date.strftime("%d-%b-%Y")


def _clean_text(raw_bytes: bytes) -> str:
    """Decodes bytes to string and strips HTML tags."""
    try:
        text = raw_bytes.decode('utf-8', errors='ignore')
    except Exception:
        return ""
    text = re.sub('<[^<]+?>', ' ', text)
    return text


def _aadhaar_last4(raw: str) -> str:
    """
    Extracts the last 4 digits from any masked Aadhaar string.
    'xxxx xxxx 6088'  → '6088'
    'XXXX-XXXX-6088'  → '6088'
    'xxxxxxxx6088'    → '6088'
    """
    digits = re.sub(r'[^0-9]', '', raw)
    return digits[-4:] if len(digits) >= 4 else digits


def _normalise_dob(raw: str) -> Optional[str]:
    """
    Converts any reasonable date string to DD-MM-YYYY.
    Handles: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD.
    Returns None if the date cannot be parsed.
    """
    raw = raw.strip()
    for fmt in ('%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(raw, fmt).strftime('%d-%m-%Y')
        except ValueError:
            continue
    return None


def _normalise_gender(raw: str) -> Optional[str]:
    """Maps email gender strings ('MALE', 'Female', etc.) to M / F / T."""
    return _GENDER_MAP.get(raw.strip().lower())


# ── HTML table cell extractor ─────────────────────────────────────

class _TableCellExtractor(HTMLParser):
    """Collects <td>/<th> cell text grouped by enclosing <table>."""
    def __init__(self):
        super().__init__()
        self._in_cell = False
        self._buf:    list[str]       = []
        self.tables:  list[list[str]] = []

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.tables.append([])
        elif tag in ('td', 'th'):
            self._in_cell = True
            self._buf     = []

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self._in_cell:
            cell_text = ' '.join(self._buf).strip()
            if cell_text:
                if self.tables:
                    self.tables[-1].append(cell_text)
                else:
                    self.tables.append([cell_text])
            self._in_cell = False

    def handle_data(self, data):
        if self._in_cell:
            stripped = data.strip()
            if stripped:
                self._buf.append(stripped)


def _customers_from_html(html_bytes: bytes) -> list[CustomerData]:
    """
    PRIMARY extractor — reads the structured HTML email template.

    Scans every <table> for labeled cells:
        "PAN: BJTPY1837L"
        "Aadhaar No: xxxx xxxx 6088"
        "Name: ROHIT YADAV"
        "Date of Birth: 01/06/2003"
        "Gender: MALE"

    One CustomerData per table that contains at least a PAN cell.
    The Aadhaar line is only emitted when all four UID fields are present
    (aadhaar_last4, name, dob, gender).
    """
    try:
        html_str = html_bytes.decode('utf-8', errors='ignore')
    except Exception:
        return []

    extractor = _TableCellExtractor()
    try:
        extractor.feed(html_str)
    except Exception:
        return []

    customers: list[CustomerData] = []

    for table_cells in extractor.tables:
        # One pass — collect all labeled values from this table
        pan:           Optional[str] = None
        aadhaar_last4: Optional[str] = None
        name:          Optional[str] = None
        dob:           Optional[str] = None
        gender:        Optional[str] = None

        for cell in table_cells:
            cn = re.sub(r'\s+', ' ', cell).strip()  # normalise whitespace

            # ── PAN ──────────────────────────────────────────────
            m = re.match(r'(?i)^PAN\s*:\s*([A-Z]{5}[0-9]{4}[A-Z])\b', cn)
            if m:
                pan = m.group(1)
                continue

            # Bare PAN inside a cell that mentions PAN
            bare = PAN_REGEX.findall(cn)
            if bare and re.search(r'(?i)\bPAN\b', cn):
                pan = bare[0]
                continue

            # ── Aadhaar ───────────────────────────────────────────
            m = re.search(
                r'(?i)Aadhaar\s*(?:No|Number|#)?\s*[:\-]?\s*'
                r'([Xx\*]{4}[\s\-]?[Xx\*]{4}[\s\-]?\d{4})',
                cn,
            )
            if m:
                aadhaar_last4 = _aadhaar_last4(m.group(1))
                continue

            # ── Name ──────────────────────────────────────────────
            m = re.match(r'(?i)^Name\s*:\s*(.+)$', cn)
            if m:
                name = m.group(1).strip()
                continue

            # ── Date of Birth ─────────────────────────────────────
            m = re.match(r'(?i)^Date\s+of\s+Birth\s*:\s*(.+)$', cn)
            if m:
                dob = _normalise_dob(m.group(1))
                continue

            # ── Gender ────────────────────────────────────────────
            m = re.match(r'(?i)^Gender\s*:\s*(\S+)', cn)
            if m:
                gender = _normalise_gender(m.group(1))
                continue

        if pan:
            customers.append(CustomerData(
                pan=pan,
                aadhaar_last4=aadhaar_last4,
                name=name,
                dob=dob,
                gender=gender,
            ))

    return customers


def _customers_from_plain_text(text: str) -> list[CustomerData]:
    """
    FALLBACK extractor for plain-text emails.

    Finds PANs and masked Aadhaars and pairs them by proximity.
    Attempts to extract Name / DOB / Gender from nearby lines.
    """
    pan_hits: list[tuple[int, str]] = [
        (m.start(), m.group()) for m in PAN_REGEX.finditer(text)
    ]
    aa_hits: list[tuple[int, str]] = [
        (m.start(), _aadhaar_last4(m.group()))
        for m in AADHAAR_MASKED_REGEX.finditer(text)
    ]

    if not pan_hits:
        return []

    # Try to pull Name / DOB / Gender from flat text via simple patterns
    name_m   = re.search(r'(?i)Name\s*:\s*(.+)', text)
    dob_m    = re.search(r'(?i)Date\s+of\s+Birth\s*:\s*([\d/\-]+)', text)
    gender_m = re.search(r'(?i)Gender\s*:\s*(\S+)', text)

    flat_name   = name_m.group(1).strip()           if name_m   else None
    flat_dob    = _normalise_dob(dob_m.group(1))    if dob_m    else None
    flat_gender = _normalise_gender(gender_m.group(1)) if gender_m else None

    used: set[int] = set()
    customers: list[CustomerData] = []

    for pan_pos, pan in pan_hits:
        best_idx = None
        best_dist = float('inf')
        for idx, (a_pos, _) in enumerate(aa_hits):
            if idx in used:
                continue
            d = abs(pan_pos - a_pos)
            if d < best_dist:
                best_dist = d
                best_idx  = idx

        aadhaar_last4 = None
        if best_idx is not None:
            used.add(best_idx)
            aadhaar_last4 = aa_hits[best_idx][1]

        customers.append(CustomerData(
            pan=pan,
            aadhaar_last4=aadhaar_last4,
            name=flat_name,
            dob=flat_dob,
            gender=flat_gender,
        ))

    return customers


def _extract_customers_from_msg(msg) -> list[CustomerData]:
    """
    Routes to HTML or plain-text extractor based on email content type.
    HTML path uses structured table-cell parsing (precise).
    Plain-text path uses proximity + pattern matching (best-effort).
    """
    subject_str = ""
    subject_val = msg.get("Subject", "")
    if subject_val:
        decoded_list = decode_header(subject_val)
        for content, encoding in decoded_list:
            if isinstance(content, bytes):
                subject_str += content.decode(encoding or 'utf-8', errors='ignore')
            else:
                subject_str += str(content)

    html_parts:  list[bytes] = []
    plain_parts: list[str]   = []

    if msg.is_multipart():
        for part in msg.walk():
            try:
                ct      = part.get_content_type()
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                if ct == 'text/html':
                    html_parts.append(payload)
                elif ct == 'text/plain':
                    plain_parts.append(_clean_text(payload))
            except Exception:
                continue
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                if msg.get_content_type() == 'text/html':
                    html_parts.append(payload)
                else:
                    plain_parts.append(_clean_text(payload))
        except Exception:
            pass

    # ── Primary: HTML table cell extraction ──────────────────────
    if html_parts:
        customers: list[CustomerData] = []
        for html_bytes in html_parts:
            customers.extend(_customers_from_html(html_bytes))
        if customers:
            log.debug(f"HTML extraction: {len(customers)} customer(s)")
            return customers

    # ── Fallback: plain-text ──────────────────────────────────────
    full_text = subject_str + "\n" + "\n".join(plain_parts)
    customers = _customers_from_plain_text(full_text)
    log.debug(f"Plain-text extraction: {len(customers)} customer(s)")
    return customers


def fetch_customers(year: int, month: int, day: int) -> list[CustomerData]:
    """
    Connects to Gmail via IMAP, searches emails for the target date,
    extracts CustomerData for every customer found.

    Returns a sorted, deduplicated list (keyed on PAN).
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

    # pan → CustomerData (prefer entries that have Aadhaar data)
    all_customers: dict[str, CustomerData] = {}

    try:
        mail.select("inbox")

        since_date, before_date = _get_imap_date_range(year, month, day)
        search_criteria = f'(SINCE "{since_date}" BEFORE "{before_date}")'
        log.info(f"Searching emails: {search_criteria}")

        status, messages = mail.search(None, search_criteria)
        if status != "OK":
            raise RuntimeError(f"IMAP search failed with status: {status}")

        email_ids    = messages[0].split()
        total_emails = len(email_ids)

        if total_emails == 0:
            log.info("No emails found for this date range.")
            return []

        log.info(f"Found {total_emails} email(s). Extracting customer data...")

        for i, eid in enumerate(email_ids, 1):
            log.info(f"Scanning email {i}/{total_emails}...")
            try:
                _, data = mail.fetch(eid, '(BODY.PEEK[]<0.50000>)')
                if data and data[0]:
                    msg       = email.message_from_bytes(data[0][1])
                    customers = _extract_customers_from_msg(msg)
                    for cust in customers:
                        pan = cust.pan
                        # Prefer records with Aadhaar data over PAN-only
                        if pan not in all_customers or (
                            cust.has_aadhaar_line and
                            not all_customers[pan].has_aadhaar_line
                        ):
                            all_customers[pan] = cust
            except Exception as e:
                log.warning(f"Failed to parse email {eid}: {e}")
                continue

    finally:
        try:
            mail.close()
            mail.logout()
        except Exception:
            pass

    # Validate PANs and sort
    result: list[CustomerData] = []
    for pan, cust in sorted(all_customers.items()):
        if re.match(r'^[A-Z]{5}[0-9]{4}[A-Z]$', pan):
            result.append(cust)

    with_aa  = sum(1 for c in result if c.has_aadhaar_line)
    without  = len(result) - with_aa
    log.info(
        f"Extraction complete. {len(result)} unique customer(s): "
        f"{with_aa} with full Aadhaar data, {without} PAN-only."
    )

    return result


# ════════════════════════════════════════════════════════════════════
# PART 2 — FILE FORMATTING
# ════════════════════════════════════════════════════════════════════

def _normalize_version(v: str) -> str:
    v = str(v).strip()
    return v if v.upper().startswith("V") else f"V{v}"


def _write_header_line(fi_code: str, region: str, total_records: int,
                       version: str, date_str: str) -> str:
    """Type 10 Header: 10|FI|REG|COUNT|VER|DATE||||"""
    return "|".join(["10", fi_code, region, str(total_records),
                     _normalize_version(version), date_str, "", "", "", ""])


def _write_pan_line(seq: int, pan: str) -> str:
    """
    Type 20 PAN line (identity type C).
    Format: 20|seq|C|PAN||||
    """
    return "|".join(["20", str(seq), "C", pan, "", "", "", ""])


def _write_aadhaar_line(seq: int, cust: CustomerData) -> str:
    """
    Type 20 Aadhaar line (identity type E / UID).
    Format: 20|seq|E|<last4>|<Name>|<DOB DD-MM-YYYY>|<Gender M/F/T>||||

    Name, DOB, Gender are mandatory for identity type E per the CKYC spec.
    Only call this when cust.has_aadhaar_line is True.
    """
    return "|".join([
        "20",
        str(seq),
        "E",
        cust.aadhaar_last4,   # last 4 digits only — e.g. "6088"
        cust.name,            # e.g. "ROHIT YADAV"
        cust.dob,             # e.g. "01-06-2003"
        cust.gender,          # M / F / T
        "", "", "", "",
    ])


def build_ckyc_file_bytes(customers: list[CustomerData], date_str: str) -> bytes:
    """
    Formats customer data into the CKYC pipe-delimited search file.

    For each customer two consecutive Type-20 lines are emitted when all
    mandatory Aadhaar fields (last4, name, dob, gender) are available:
        20|N|C|<PAN>||||                             ← PAN line
        20|N+1|E|<last4>|<Name>|<DOB>|<Gender>||||  ← Aadhaar line

    If a customer's Aadhaar data is incomplete, only the PAN line is written.
    The header count reflects the actual number of Type-20 lines written.
    Returns the complete file as UTF-8 bytes with CRLF line endings.
    """
    # Deduplicate by PAN while preserving sort order
    seen:   set[str]            = set()
    unique: list[CustomerData]  = []
    for cust in customers:
        if cust.pan not in seen:
            seen.add(cust.pan)
            unique.append(cust)

    if not unique:
        raise ValueError("No valid customers to write — cannot generate empty CKYC file.")

    total_lines = sum(2 if c.has_aadhaar_line else 1 for c in unique)

    lines = [_write_header_line(FI_CODE, REGION, total_lines, VERSION, date_str)]

    seq = 1
    for cust in unique:
        lines.append(_write_pan_line(seq, cust.pan))
        seq += 1

        if cust.has_aadhaar_line:
            lines.append(_write_aadhaar_line(seq, cust))
            seq += 1

    content = "\r\n".join(lines) + "\r\n"
    return content.encode('utf-8')


def build_pan_dob_payload(customers: list[CustomerData], target_date: str) -> dict:
    """Builds the intermediate PAN/DOB mapping persisted for downstream jobs."""
    unique_by_pan: dict[str, CustomerData] = {}
    for cust in customers:
        unique_by_pan.setdefault(cust.pan, cust)

    return {
        "target_date": target_date,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "customer_count": len(unique_by_pan),
        "customers": [
            {
                "pan": cust.pan,
                "aadhaar_last4": cust.aadhaar_last4,
                "name": cust.name,
                "dob": cust.dob,
                "gender": cust.gender,
                "has_aadhaar_line": cust.has_aadhaar_line,
            }
            for cust in unique_by_pan.values()
        ],
    }


def derive_pan_dob_r2_key(search_r2_key: str) -> str:
    if '.' in search_r2_key:
        stem, _ = search_r2_key.rsplit('.', 1)
    else:
        stem = search_r2_key
    return f"{stem}_pan_dob.json"


# ════════════════════════════════════════════════════════════════════
# PART 3 — R2 UPLOAD
# ════════════════════════════════════════════════════════════════════

def upload_to_r2(file_bytes: bytes, r2_key: str, content_type: str = 'text/plain') -> None:
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
        ContentType = content_type,
    )

    log.info(f"Upload complete: {r2_key}")


# ════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════

def main():
    try:
        raw_input = sys.stdin.read()
        payload   = json.loads(raw_input)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to parse stdin JSON: {e}"}))
        sys.exit(1)

    target_date    = payload.get('target_date')
    batch_sequence = payload.get('batch_sequence')
    r2_output_key  = payload.get('r2_output_key')

    if not target_date or not batch_sequence or not r2_output_key:
        print(json.dumps({
            "success": False,
            "error":   "stdin payload missing required fields: target_date, batch_sequence, r2_output_key"
        }))
        sys.exit(1)

    try:
        dt    = datetime.strptime(target_date, "%Y-%m-%d")
        year  = dt.year
        month = dt.month
        day   = dt.day
    except ValueError as e:
        print(json.dumps({"success": False, "error": f"Invalid target_date format: {e}"}))
        sys.exit(1)

    header_date_str = dt.strftime("%d-%m-%Y")

    log.info(f"search_generator.py started — target_date={target_date} batch_sequence={batch_sequence}")

    # ── Step 1: Fetch customer data from Gmail ────────────────────
    try:
        customers = fetch_customers(year, month, day)
    except Exception as e:
        log.error(f"Customer extraction failed: {e}")
        print(json.dumps({"success": False, "error": f"Customer extraction failed: {e}"}))
        sys.exit(1)

    if not customers:
        print(json.dumps({
            "success": False,
            "error":   f"No customers found in emails for {target_date}.",
        }))
        sys.exit(1)

    # ── Step 2: Format into CKYC file bytes ───────────────────────
    try:
        file_bytes = build_ckyc_file_bytes(customers, header_date_str)
    except Exception as e:
        log.error(f"File formatting failed: {e}")
        print(json.dumps({"success": False, "error": f"File formatting failed: {e}"}))
        sys.exit(1)

    total_lines = sum(2 if c.has_aadhaar_line else 1 for c in customers)
    log.info(f"CKYC file built — {len(file_bytes)} bytes, {total_lines} detail lines")

    # ── Step 3: Upload to R2 ──────────────────────────────────────
    try:
        upload_to_r2(file_bytes, r2_output_key)
    except Exception as e:
        log.error(f"R2 upload failed: {e}")
        print(json.dumps({"success": False, "error": f"R2 upload failed: {e}"}))
        sys.exit(1)

    pan_dob_r2_key = derive_pan_dob_r2_key(r2_output_key)
    try:
        pan_dob_payload = build_pan_dob_payload(customers, target_date)
        pan_dob_bytes = json.dumps(pan_dob_payload).encode('utf-8')
        upload_to_r2(pan_dob_bytes, pan_dob_r2_key, 'application/json')
    except Exception as e:
        log.error(f"PAN/DOB mapping upload failed: {e}")
        print(json.dumps({"success": False, "error": f"PAN/DOB mapping upload failed: {e}"}))
        sys.exit(1)

    # ── Step 4: Success ───────────────────────────────────────────
    result = {
        "success":        True,
        "record_count":   total_lines,
        "r2_key_written": r2_output_key,
        "pan_dob_r2_key": pan_dob_r2_key,
    }
    log.info(f"search_generator.py complete — {total_lines} lines written to {r2_output_key}")
    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()
