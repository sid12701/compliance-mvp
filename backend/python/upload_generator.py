#!/usr/bin/env python3
# backend/python/upload_generator.py
#
# Modified ckyc_processor.py — platform-integrated version
#
# Reads from stdin (JSON):
#   {
#     "target_date":          "2026-03-09",
#     "batch_sequence":       16,
#     "pan_list":             ["ABCDE1234F", "XYZPQ5678G", ...],
#     "r2_output_key_prefix": "ckyc/09-03-2026/upload/"
#   }
#
# Writes to stdout on success (JSON):
#   {
#     "success":          true,
#     "records_processed": 44,
#     "files_generated":  [
#       { "r2_key": "ckyc/09-03-2026/upload/IN3860_IT_09032026_V1.3_IRA010431_U10001.zip",
#         "file_size_bytes": 84302 }
#     ]
#   }
#
# Writes to stdout on failure (JSON):
#   { "success": false, "error": "Human readable error message" }
#
# ALL diagnostic logging → stderr only.
# stdout is reserved for the single JSON result line Node.js reads.

from __future__ import annotations

import imaplib
import email
import io
import re
import os
import sys
import json
import logging
import zipfile
import traceback
from email.header import decode_header
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import boto3
from botocore.config import Config
from bs4 import BeautifulSoup

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

# Gmail — read directly from environment (Node.js inherits these to Python)
GMAIL_ADDRESS      = os.environ.get('GMAIL_ADDRESS')
GMAIL_APP_PASSWORD = os.environ.get('GMAIL_APP_PASSWORD')

# R2 — same vars as Node.js r2.service.js
R2_ACCOUNT_ID        = os.environ.get('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID     = os.environ.get('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.environ.get('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME       = os.environ.get('R2_BUCKET_NAME')
R2_PUBLIC_ENDPOINT   = os.environ.get('R2_PUBLIC_ENDPOINT')

# CKYC constants — identical to original config.py CKYC_CONFIG
CKYC_CONFIG = {
    'fi_code':             'IN3860',
    'region_code':         'IT',
    'branch_code':         'ITBR',
    'user_id':             'IRA010431',
    'batch_start_number':  10001,
    'version':             'V1.3',
    'customer_type':       '01',
    'constitution_type':   '1',
    'fi_branch_name':      'Gurgaon',
    'organization_type':   '1',
    'is_existing_customer': '1',
}

# Identical to original config.py FIELD_DEFAULTS
FIELD_DEFAULTS = {
    'account_type':                    '01',
    'proof_of_address':                '01',
    'current_proof_of_address':        '01',
    'identity_code':                   'E',
    'verification_status':             '02',
    'country':                         'IN',
    'current_address_provided_flag':   'Y',
}

# Identical to original config.py IMAGE_TYPES
IMAGE_TYPES = {
    'photograph':        '02',
    'aadhaar_proof':     '04',
    'aadhaar_back_proof': '37',
    'pan':               '03',
    'signature':         '09',
}

# Identical to original config.py ATTACHMENT_PATTERNS
ATTACHMENT_PATTERNS = {
    'selfie':            'selfie_image',
    'aadhaar_file':      'aadhaarfile',
    'aadhaar_front':     'aadhaar_front_image',
    'aadhaar_back':      'aadhaar_back_image',
    'pan_verification':  'pan_verification_response',
    'bureau_report':     'bureau_report',
    'kfs':               'kfs_',
    'la':                'la_',
}

REQUIRED_ATTACHMENTS = ['selfie']

# Identical to original config.py EMAIL_CONFIG
EMAIL_CONFIG = {
    'imap_server': 'imap.gmail.com',
    'imap_port':   993,
}

# Identical to original config.py PROCESSING_CONFIG
PROCESSING_CONFIG = {
    'continue_on_error':           True,
    'skip_on_missing_required':    True,
    'skip_on_missing_fields':      True,
}

CRITICAL_FIELDS = ['name', 'dob', 'gender', 'pan', 'address', 'mobile']

# Identical to original config.py GENDER_MAP
GENDER_MAP = {
    'MALE': 'M', 'FEMALE': 'F',
    'TRANSGENDER': 'T', 'THIRD GENDER': 'T',
}

# Identical to original config.py STATE_CODES (full map preserved)
STATE_CODES = {
    'ANDAMAN AND NICOBAR': 'AN', 'ANDHRA PRADESH': 'AP',
    'ARUNACHAL PRADESH': 'AR',   'ASSAM': 'AS',
    'BIHAR': 'BR',               'CHANDIGARH': 'CH',
    'CHHATTISGARH': 'CG',        'DADRA AND NAGAR HAVELI': 'DD',
    'DAMAN AND DIU': 'DD',       'DELHI': 'DL',
    'GOA': 'GA',                 'GUJARAT': 'GJ',
    'HARYANA': 'HR',             'HIMACHAL PRADESH': 'HP',
    'JAMMU AND KASHMIR': 'JK',   'JHARKHAND': 'JH',
    'KARNATAKA': 'KA',           'KERALA': 'KL',
    'LADAKH': 'LA',              'LAKSHADWEEP': 'LD',
    'MADHYA PRADESH': 'MP',      'MAHARASHTRA': 'MH',
    'MANIPUR': 'MN',             'MEGHALAYA': 'ML',
    'MIZORAM': 'MZ',             'NAGALAND': 'NL',
    'ODISHA': 'OD',              'PUDUCHERRY': 'PY',
    'PUNJAB': 'PB',              'RAJASTHAN': 'RJ',
    'SIKKIM': 'SK',              'TAMIL NADU': 'TN',
    'TELANGANA': 'TS',           'TRIPURA': 'TR',
    'UTTAR PRADESH': 'UP',       'UTTARAKHAND': 'UK',
    'WEST BENGAL': 'WB',
}

PAN_REGEX = re.compile(r'^[A-Z]{5}[0-9]{4}[A-Z]$')

# ════════════════════════════════════════════════════════════════════
# FILENAME HELPERS — identical logic to original
# ════════════════════════════════════════════════════════════════════

def build_batch_name(batch_number: int, run_dt: datetime) -> str:
    """
    Builds the batch name string used for the ZIP filename and folder.
    run_dt is now the target_date from the payload — not datetime.now().
    This ensures the filename date matches the business date.
    """
    date_str = run_dt.strftime('%d%m%Y')
    return (
        f"{CKYC_CONFIG['fi_code']}_"
        f"{CKYC_CONFIG['region_code']}_"
        f"{date_str}_"
        f"{CKYC_CONFIG['version']}_"
        f"{CKYC_CONFIG['user_id']}_"
        f"U{batch_number}"
    )


def build_image_name(unique_id: str, image_code: str,
                     source_filename: str, dt: datetime) -> str:
    """Identical to original build_image_name()."""
    ts  = dt.strftime('%d%m%Y%H%M%S')
    ext = os.path.splitext(source_filename)[1]
    ext = ext.lstrip('.').lower() if ext else 'bin'
    return f"{unique_id}_{image_code}_{ts}.{ext}"


# ════════════════════════════════════════════════════════════════════
# HELPER — identical to original
# ════════════════════════════════════════════════════════════════════

def _objectid_to_ref(loan_id: str) -> str:
    """
    Convert MongoDB ObjectId (24-char hex) to stable 20-digit numeric string.
    Identical to original — deterministic, collision-free.
    """
    if not loan_id:
        return '00000000000000000000'
    try:
        return str(int(loan_id, 16) % (10 ** 20)).zfill(20)
    except ValueError:
        return str(int(loan_id) % (10 ** 20)).zfill(20)


# ════════════════════════════════════════════════════════════════════
# R2 UPLOAD — replaces local disk write
# ════════════════════════════════════════════════════════════════════

def upload_to_r2(file_bytes: bytes, r2_key: str) -> None:
    """
    Uploads zip bytes to Cloudflare R2.
    Raises on any failure so the caller can record FAILED status.
    """
    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
                R2_BUCKET_NAME, R2_PUBLIC_ENDPOINT]):
        raise RuntimeError(
            "One or more R2 environment variables are missing."
        )

    log.info(f"Uploading {len(file_bytes):,} bytes to R2: {r2_key}")

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
        ContentType = 'application/zip',
    )

    log.info(f"R2 upload complete: {r2_key}")


# ════════════════════════════════════════════════════════════════════
# GMAIL CONNECTOR — identical logic, credentials from os.environ
# ════════════════════════════════════════════════════════════════════

class GmailConnector:
    def __init__(self):
        # Credentials from environment — never from config.py
        self.email_address = GMAIL_ADDRESS
        self.app_password  = GMAIL_APP_PASSWORD
        self.imap          = None

    def connect(self) -> bool:
        if not self.email_address or not self.app_password:
            log.error("GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set in environment.")
            return False
        try:
            log.info(f"Connecting to Gmail: {self.email_address}")
            self.imap = imaplib.IMAP4_SSL(
                EMAIL_CONFIG['imap_server'],
                EMAIL_CONFIG['imap_port']
            )
            self.imap.login(self.email_address, self.app_password)
            self.imap.select('INBOX')
            log.info("Connected to Gmail")
            return True
        except Exception as e:
            log.error(f"Failed to connect to Gmail: {e}")
            return False

    def search_emails(self, pan: str, year: int, month: int,
                      day: Optional[int] = None) -> List[bytes]:
        """Identical search logic to original GmailConnector.search_emails()."""
        try:
            MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

            if day:
                date_criteria = f'ON "{day:02d}-{MONTH_ABBR[month]}-{year}"'
            else:
                since  = f'01-{MONTH_ABBR[month]}-{year}'
                before = (
                    f'01-Jan-{year + 1}' if month == 12
                    else f'01-{MONTH_ABBR[month + 1]}-{year}'
                )
                date_criteria = f'SINCE "{since}" BEFORE "{before}"'

            pan_upper = pan.upper()
            queries   = [f'({date_criteria} BODY "{pan_upper}")']
            if pan != pan_upper:
                queries.append(f'({date_criteria} BODY "{pan}")')

            matched: set = set()
            for query in queries:
                status, messages = self.imap.search(None, query)
                if status != 'OK':
                    continue
                matched.update(messages[0].split())

            result = list(matched)
            log.info(f"PAN {pan}: {len(result)} email(s) found")
            return result

        except Exception as e:
            log.error(f"Error searching emails for PAN {pan}: {e}")
            return []

    def fetch_email(self, email_id: bytes) -> Optional[email.message.Message]:
        try:
            status, msg_data = self.imap.fetch(email_id, '(RFC822)')
            if status != 'OK':
                return None
            return email.message_from_bytes(msg_data[0][1])
        except Exception as e:
            log.error(f"Error fetching email: {e}")
            return None

    def disconnect(self):
        if self.imap:
            try:
                self.imap.close()
                self.imap.logout()
                log.info("Disconnected from Gmail")
            except Exception:
                pass


# ════════════════════════════════════════════════════════════════════
# EMAIL DATA EXTRACTOR — identical to original, no changes
# ════════════════════════════════════════════════════════════════════

class EmailDataExtractor:
    def __init__(self, email_message: email.message.Message):
        self.email_message = email_message
        self.html_content  = self._get_html_content()
        self.soup = (
            BeautifulSoup(self.html_content, 'html.parser')
            if self.html_content else None
        )

    def _get_html_content(self) -> Optional[str]:
        if self.email_message.is_multipart():
            for part in self.email_message.walk():
                if part.get_content_type() == "text/html":
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            return payload.decode('utf-8', errors='ignore')
                    except Exception:
                        pass
        else:
            if self.email_message.get_content_type() == "text/html":
                try:
                    payload = self.email_message.get_payload(decode=True)
                    if payload:
                        return payload.decode('utf-8', errors='ignore')
                except Exception:
                    pass
        return None

    def extract_data(self) -> Optional[Dict]:
        if not self.soup:
            log.error("No HTML content in email")
            return None
        try:
            data = {}
            data.update(self._extract_table_data("Customer Details"))
            data.update(self._extract_table_data("Loan Details"))
            if not self._validate_critical_fields(data):
                return None
            return self._process_data(data)
        except Exception as e:
            log.error(f"Error extracting data: {e}")
            return None

    def _extract_table_data(self, caption: str) -> Dict:
        data = {}
        try:
            for table in self.soup.find_all('table'):
                cap = table.find('caption')
                if cap and caption in cap.get_text():
                    for row in table.find_all('tr'):
                        for cell in row.find_all('td'):
                            text = cell.get_text(strip=True)
                            if ':' in text:
                                k, v = text.split(':', 1)
                                data[k.strip()] = v.strip()
                    break
        except Exception as e:
            log.error(f"Error reading table '{caption}': {e}")
        return data

    def _validate_critical_fields(self, data: Dict) -> bool:
        field_map = {
            'name': 'Name', 'dob': 'Date of Birth', 'gender': 'Gender',
            'pan': 'PAN', 'address': 'Address', 'mobile': 'Phone Number',
        }
        missing = [v for k, v in field_map.items()
                   if k in CRITICAL_FIELDS and not data.get(v)]
        if missing:
            log.warning(f"Missing critical fields: {', '.join(missing)}")
            return False
        return True

    def _process_data(self, data: Dict) -> Dict:
        """Identical to original _process_data() — no changes."""
        p          = {}
        name_parts = data.get('Name', '').split()
        p['first_name'] = name_parts[0] if name_parts else ''
        p['last_name']  = ' '.join(name_parts[1:]) if len(name_parts) > 1 else ''

        gender_raw   = data.get('Gender', '').upper()
        p['gender']      = GENDER_MAP.get(gender_raw, 'M')
        p['name_prefix'] = 'MR' if p['gender'] == 'M' else 'MS'

        p['dob'] = data.get('Date of Birth', '').replace('/', '-')
        p['pan'] = data.get('PAN', '')

        p.update(self._parse_address(data.get('Address', '')))

        p['mobile']         = data.get('Phone Number', '').replace(' ', '').replace('-', '')
        p['email']          = data.get('Email Id', '')
        p['account_number'] = data.get('Bank A/c No', '')
        p['loan_id']        = data.get('Loan Id', '')

        father_raw   = data.get('Father Name', '').strip()
        father_parts = father_raw.split() if father_raw else []
        p['father_prefix'] = 'MR'
        p['father_first']  = father_parts[0] if len(father_parts) > 0 else ''
        if len(father_parts) == 2:
            p['father_middle'] = ''
            p['father_last']   = father_parts[1]
        elif len(father_parts) >= 3:
            p['father_middle'] = father_parts[1]
            p['father_last']   = ' '.join(father_parts[2:])
        else:
            p['father_middle'] = ''
            p['father_last']   = ''

        aadhaar_raw     = data.get('Aadhaar No', '')
        digits_only     = re.sub(r'[^0-9]', '', aadhaar_raw)
        p['aadhaar_last4'] = digits_only[-4:] if len(digits_only) >= 4 else digits_only

        loan_date_raw  = data.get('Date', '')
        p['loan_date'] = (
            loan_date_raw.split()[0].replace('/', '-')
            if loan_date_raw else datetime.now().strftime('%d-%m-%Y')
        )

        subject    = self.email_message.get('Subject', '')
        org_match  = re.search(r'NBFC:\s*(.+?)(?:\||$)', subject)
        p['organization_name'] = (
            org_match.group(1).strip() if org_match
            else data.get('Organization', 'Bhawana Capital Private Limited')
        )
        return p

    def _parse_address(self, address: str) -> Dict:
        """Identical to original _parse_address() — full logic preserved."""
        parts = {}
        try:
            segs    = [s.strip() for s in address.split(',')]
            pincode = ''
            state   = ''

            for i, seg in enumerate(segs):
                pin_match = re.search(r'\b(\d{6})\b', seg)
                if pin_match:
                    pincode   = pin_match.group(1)
                    remaining = seg.replace(pincode, '').strip().strip('-').strip()
                    if remaining:
                        matched_state = False
                        for state_name, state_code in STATE_CODES.items():
                            if state_name in remaining.upper():
                                state    = state_code
                                leftover = re.sub(
                                    state_name, '', remaining, flags=re.IGNORECASE
                                ).strip().strip('-').strip()
                                segs[i]  = leftover
                                matched_state = True
                                break
                        if not matched_state:
                            segs[i] = remaining
                    else:
                        segs[i] = ''
                    continue

                for state_name, state_code in STATE_CODES.items():
                    if state_name in seg.upper():
                        state   = state_code
                        segs[i] = re.sub(
                            state_name, '', seg, flags=re.IGNORECASE
                        ).strip()
                        break

            segs = [s for s in segs if s]
            n    = len(segs)

            parts['address_line_1'] = segs[0] if n > 3 else ''
            parts['address_line_2'] = segs[0] if n <= 3 else segs[1]
            parts['address_line_3'] = (segs[1] if n <= 3 else segs[2]) if n > 1 else ''
            parts['address_line_4'] = (segs[2] if n == 3 else segs[3] if n > 3 else '')
            parts['city']           = segs[-2] if n > 1 else (segs[0] if n else '')
            parts['district']       = segs[-1] if n >= 1 else ''
            parts['pincode']        = pincode
            parts['state']          = state or 'DL'

        except Exception as e:
            log.error(f"Error parsing address: {e}")
            parts = {
                'address_line_1': '', 'address_line_2': address[:55],
                'address_line_3': '', 'address_line_4': '',
                'city': 'Unknown', 'district': 'Unknown',
                'state': 'DL', 'pincode': '000000',
            }
        return parts

    def get_attachments(self) -> Dict[str, bytes]:
        """Identical to original get_attachments()."""
        attachments: Dict[str, bytes] = {}
        try:
            for part in self.email_message.walk():
                if part.get_content_maintype() == 'multipart':
                    continue
                if part.get('Content-Disposition') is None:
                    continue
                filename = part.get_filename()
                if filename:
                    decoded = decode_header(filename)[0]
                    if decoded[1]:
                        filename = decoded[0].decode(decoded[1])
                    data = part.get_payload(decode=True)
                    if data:
                        attachments[filename] = data
            log.info(f"Extracted {len(attachments)} attachment(s)")
        except Exception as e:
            log.error(f"Error extracting attachments: {e}")
        return attachments


# ════════════════════════════════════════════════════════════════════
# CKYC FILE GENERATOR — identical to original, no changes
# ════════════════════════════════════════════════════════════════════

class CKYCFileGenerator:
    def __init__(self, customer_data: Dict, batch_number: int):
        self.data         = customer_data
        self.batch_number = batch_number
        self.line_number  = 1

    def generate_file_content(self, num_images: int = 0) -> str:
        return '\n'.join([
            self._build_header(),
            self._build_detail_20(num_images=num_images),
            self._build_detail_30(),
        ])

    def _build_header(self) -> str:
        return '|'.join([
            '10', str(self.batch_number),
            CKYC_CONFIG['fi_code'], CKYC_CONFIG['region_code'],
            '1', datetime.now().strftime('%d-%m-%Y'),
            CKYC_CONFIG['version'], CKYC_CONFIG['customer_type'],
            '', '', '',
        ]) + '|'

    def _build_detail_20(self, num_images: int = 0) -> str:
        d   = self.data
        now = datetime.now().strftime('%d-%m-%Y')

        fields = [
            '20', str(self.line_number), '01', CKYC_CONFIG['branch_code'],
            '', '', '', '', '', '', '', '', '', '',
            CKYC_CONFIG['constitution_type'], '', '', '01',
            _objectid_to_ref(d.get('loan_id', '')),
            d.get('name_prefix', 'MR'), d.get('first_name', ''),
            d.get('middle_name', ''),   d.get('last_name', ''), '',
            '', '', '', '', '',
            '01', d.get('father_prefix', 'MR'), d.get('father_first', ''),
            d.get('father_middle', ''), d.get('father_last', ''), '',
            '', '', '', '', '',
            d.get('gender', 'M'), '', '', '',
            d.get('dob', ''), '', '', '', '',
            '', '', '', d.get('pan', ''), '01',
            '0', '', '', '', '',
            '', d.get('address_line_1', ''), d.get('address_line_2', ''),
            d.get('address_line_3', ''), d.get('city', ''),
            d.get('district', ''), d.get('state', ''),
            FIELD_DEFAULTS['country'], d.get('pincode', ''),
            FIELD_DEFAULTS['current_proof_of_address'], '', 'Y',
            '', '', '', '', '', '', '', '', '', '',
            '', '', '', '', '', '', '', '', '', '',
            '', '', '', '', '', '', '', '', '', '',
            d.get('mobile', ''), '', '', d.get('email', ''), '',
            d.get('loan_date', now), d.get('city', ''),
            d.get('loan_date', now), '01',
            'Siddhant Daryanani', 'Technical Coordinator',
            CKYC_CONFIG['fi_branch_name'], CKYC_CONFIG['user_id'],
            d.get('organization_name', ''), CKYC_CONFIG['fi_code'],
            '1', '0', '02', '', str(num_images), '', '', '', '', '',
        ]

        if len(fields) != 121:
            log.error(f"Detail (20) has {len(fields)} fields, expected 121")
            while len(fields) < 121:
                fields.append('')
            fields = fields[:121]

        return '|'.join(fields) + '|'

    def _build_detail_30(self) -> str:
        fields = [
            '30', str(self.line_number), 'E',
            self.data.get('aadhaar_last4', ''),
            '', '', '',
            FIELD_DEFAULTS['verification_status'],
            '', '', '', '',
        ]
        assert len(fields) == 12
        return '|'.join(fields) + '|'

    def build_detail_70(self, image_filename: str, image_code: str) -> str:
        return '|'.join([
            '70', str(self.line_number),
            image_filename, image_code,
            '', '', '', '', '',
        ]) + '|'


# ════════════════════════════════════════════════════════════════════
# IMAGE COLLECTION — identical logic to original _collect_images()
# ════════════════════════════════════════════════════════════════════

def _collect_images(
    attachments: Dict[str, bytes],
    fi_ref: str,
    run_dt: datetime,
) -> List[Tuple[str, str, bytes]]:
    """
    Identical priority logic to original CKYCProcessor._collect_images().
    Selfie always included.
    Aadhaar: PDF > front image > back image.
    """
    results: List[Tuple[str, str, bytes]] = []

    def _find(pattern_key: str) -> Optional[Tuple[str, bytes]]:
        pattern = ATTACHMENT_PATTERNS.get(pattern_key, '').lower()
        if not pattern:
            return None
        for fname, data in attachments.items():
            if pattern in fname.lower():
                return fname, data
        return None

    # Selfie
    match = _find('selfie')
    if match:
        source_fname, data = match
        code     = IMAGE_TYPES['photograph']
        img_name = build_image_name(fi_ref, code, source_fname, run_dt)
        results.append((img_name, code, data))
        log.info(f"  Selfie: {source_fname} -> {img_name}")
    else:
        log.warning("  Selfie attachment not found")

    # Aadhaar — PDF takes priority
    aadhaar_pdf   = _find('aadhaar_file')
    aadhaar_front = _find('aadhaar_front')
    aadhaar_back  = _find('aadhaar_back')

    if aadhaar_pdf:
        source_fname, data = aadhaar_pdf
        code     = IMAGE_TYPES['aadhaar_proof']
        img_name = build_image_name(fi_ref, code, source_fname, run_dt)
        results.append((img_name, code, data))
        log.info(f"  Aadhaar: PDF chosen -> {img_name}")
    elif aadhaar_front:
        source_fname, data = aadhaar_front
        code     = IMAGE_TYPES['aadhaar_proof']
        img_name = build_image_name(fi_ref, code, source_fname, run_dt)
        results.append((img_name, code, data))
        log.info(f"  Aadhaar: front image -> {img_name}")
    elif aadhaar_back:
        source_fname, data = aadhaar_back
        code     = IMAGE_TYPES['aadhaar_proof']
        img_name = build_image_name(fi_ref, code, source_fname, run_dt)
        results.append((img_name, code, data))
        log.warning(f"  Aadhaar: only back image found -> {img_name}")
    else:
        log.warning("  No Aadhaar attachment found")

    return results


def _validate_attachments(attachments: Dict[str, bytes]) -> bool:
    """Identical validation logic to original."""
    for key in REQUIRED_ATTACHMENTS:
        pattern = ATTACHMENT_PATTERNS.get(key, '').lower()
        if not any(pattern in f.lower() for f in attachments):
            log.warning(f"Missing required attachment: {key}")
            return False

    aadhaar_keys = ['aadhaar_file', 'aadhaar_front', 'aadhaar_back']
    has_aadhaar  = any(
        ATTACHMENT_PATTERNS.get(k, '').lower() in f.lower()
        for k in aadhaar_keys
        for f in attachments
    )
    if not has_aadhaar:
        log.warning("Missing Aadhaar attachment")
        return False

    return True


# ════════════════════════════════════════════════════════════════════
# ZIP BUILDER — replaces local disk write with in-memory bytes
# ════════════════════════════════════════════════════════════════════

def build_zip_bytes(
    customer_data: Dict,
    attachments: Dict[str, bytes],
    batch_number: int,
    run_dt: datetime,
) -> Optional[bytes]:
    """
    Builds the complete outer ZIP in memory.
    Returns bytes ready for R2 upload, or None on failure.

    ZIP structure identical to original:
    {batch_name}.zip
    └── {batch_name}/
        ├── {batch_name}.txt
        └── {fi_ref}.zip
            └── {fi_ref}/
                ├── {fi_ref}_02_{ts}.jpg   (selfie)
                └── {fi_ref}_04_{ts}.pdf   (aadhaar)
    """
    try:
        loan_id    = (
            customer_data.get('loan_id')
            or customer_data.get('account_number')
            or 'UNKNOWN'
        )
        fi_ref     = _objectid_to_ref(loan_id)
        batch_name = build_batch_name(batch_number, run_dt)

        images = _collect_images(attachments, fi_ref, run_dt)
        if not images:
            log.error("No images prepared — cannot build ZIP")
            return None

        # Build CKYC text file content
        gen         = CKYCFileGenerator(customer_data, batch_number)
        txt_content = gen.generate_file_content(num_images=len(images))
        detail_70s  = [
            gen.build_detail_70(img_name, img_code)
            for img_name, img_code, _ in images
        ]
        txt_content += '\n' + '\n'.join(detail_70s)

        # Build inner ZIP (images)
        inner_buf = io.BytesIO()
        with zipfile.ZipFile(inner_buf, 'w', zipfile.ZIP_DEFLATED) as inner_zf:
            for img_name, _, img_data in images:
                inner_zf.writestr(f"{fi_ref}/{img_name}", img_data)
        inner_zip_bytes = inner_buf.getvalue()

        # Build outer ZIP (txt + inner zip)
        outer_buf = io.BytesIO()
        with zipfile.ZipFile(outer_buf, 'w', zipfile.ZIP_DEFLATED) as outer_zf:
            outer_zf.writestr(f"{batch_name}/{batch_name}.txt", txt_content)
            outer_zf.writestr(f"{batch_name}/{fi_ref}.zip", inner_zip_bytes)

        return outer_buf.getvalue()

    except Exception as e:
        log.error(f"Error building ZIP: {e}")
        log.debug(traceback.format_exc())
        return None


# ════════════════════════════════════════════════════════════════════
# MAIN PROCESSOR
# ════════════════════════════════════════════════════════════════════

def process_pan_list(
    pan_list:            List[str],
    year:                int,
    month:               int,
    day:                 int,
    run_dt:              datetime,
    r2_output_key_prefix: str,
) -> List[Dict]:
    """
    Processes each PAN in the list.
    Returns list of { r2_key, file_size_bytes } for successfully generated files.
    Replaces CKYCProcessor.process_all() — no disk writes, no BatchTracker.
    """
    files_generated = []

    gmail = GmailConnector()
    if not gmail.connect():
        raise RuntimeError("Failed to connect to Gmail")

    try:
        for idx, pan in enumerate(pan_list, 1):
            log.info(f"[{idx}/{len(pan_list)}] Processing PAN: {pan}")

            # Assign batch number: batch_start_number + (idx - 1)
            # Each PAN gets a unique sequential batch number
            batch_number = CKYC_CONFIG['batch_start_number'] + (idx - 1)

            try:
                email_ids = gmail.search_emails(pan, year, month, day)

                if not email_ids:
                    log.warning(f"  No emails found for PAN {pan} — skipping")
                    continue

                # Use first matching email — identical to original behaviour
                msg = gmail.fetch_email(email_ids[0])
                if not msg:
                    log.error(f"  Could not fetch email for PAN {pan} — skipping")
                    continue

                extractor     = EmailDataExtractor(msg)
                customer_data = extractor.extract_data()
                if not customer_data:
                    log.error(f"  Data extraction failed for PAN {pan} — skipping")
                    continue

                attachments = extractor.get_attachments()
                if not _validate_attachments(attachments):
                    log.warning(f"  Missing required attachments for PAN {pan} — skipping")
                    continue

                # Build ZIP in memory
                zip_bytes = build_zip_bytes(customer_data, attachments, batch_number, run_dt)
                if not zip_bytes:
                    log.error(f"  ZIP build failed for PAN {pan} — skipping")
                    continue

                # Build R2 key
                batch_name = build_batch_name(batch_number, run_dt)
                r2_key     = f"{r2_output_key_prefix}{batch_name}.zip"

                # Upload to R2
                upload_to_r2(zip_bytes, r2_key)

                files_generated.append({
                    'r2_key':          r2_key,
                    'file_size_bytes': len(zip_bytes),
                    'pan':             pan,  # included for logging, not stored in queue
                })

                log.info(f"  ✓ PAN {pan} -> {r2_key} ({len(zip_bytes):,} bytes)")

            except Exception as e:
                log.error(f"  Error processing PAN {pan}: {e}")
                log.debug(traceback.format_exc())
                if not PROCESSING_CONFIG['continue_on_error']:
                    raise

    finally:
        gmail.disconnect()

    return files_generated


# ════════════════════════════════════════════════════════════════════
# MAIN — stdin → process → upload → stdout
# ════════════════════════════════════════════════════════════════════

def main():
    # ── Read payload from stdin ───────────────────────────────────
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to parse stdin JSON: {e}"}))
        sys.exit(1)

    target_date           = payload.get('target_date')
    batch_sequence        = payload.get('batch_sequence')
    pan_list              = payload.get('pan_list', [])
    r2_output_key_prefix  = payload.get('r2_output_key_prefix')

    # ── Validate ──────────────────────────────────────────────────
    if not target_date or not batch_sequence or not r2_output_key_prefix:
        print(json.dumps({
            "success": False,
            "error":   "stdin payload missing: target_date, batch_sequence, r2_output_key_prefix"
        }))
        sys.exit(1)

    if not pan_list:
        print(json.dumps({"success": False, "error": "pan_list is empty"}))
        sys.exit(1)

    # ── Parse target_date ─────────────────────────────────────────
    try:
        run_dt = datetime.strptime(target_date, "%Y-%m-%d")
        year   = run_dt.year
        month  = run_dt.month
        day    = run_dt.day
    except ValueError as e:
        print(json.dumps({"success": False, "error": f"Invalid target_date: {e}"}))
        sys.exit(1)

    log.info(
        f"upload_generator.py started — "
        f"target_date={target_date} "
        f"batch_sequence={batch_sequence} "
        f"pan_count={len(pan_list)}"
    )

    # ── Process all PANs ──────────────────────────────────────────
    try:
        files_generated = process_pan_list(
            pan_list, year, month, day, run_dt, r2_output_key_prefix
        )
    except Exception as e:
        log.error(f"Fatal error: {e}")
        print(json.dumps({"success": False, "error": f"Processing failed: {e}"}))
        sys.exit(1)

    if not files_generated:
        print(json.dumps({
            "success": False,
            "error":   f"No files generated — no valid emails found for any PAN in {target_date}"
        }))
        sys.exit(1)

    # ── Success ───────────────────────────────────────────────────
    result = {
        "success":          True,
        "records_processed": len(files_generated),
        "files_generated":  [
            {"r2_key": f["r2_key"], "file_size_bytes": f["file_size_bytes"]}
            for f in files_generated
        ],
    }

    log.info(
        f"upload_generator.py complete — "
        f"{len(files_generated)} file(s) generated"
    )

    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()