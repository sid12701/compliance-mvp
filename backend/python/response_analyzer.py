#!/usr/bin/env python3
# response_analyzer.py
#
# Called by responseAnalysis.worker.js via stdin/stdout (ipcRunner pattern).
#
# stdin:  JSON { "target_date": "YYYY-MM-DD", "batch_sequence": N,
#                "response_file_content": "<base64 encoded file>" }
#
# stdout success:
#   {
#     "success": true,
#     "download_list":  [...ckyc reference IDs...],   ← for bulk download
#     "upload_list":    [...PANs not found...],        ← for upload generator
#     "download_count": N,
#     "upload_count":   N,
#     "analyzed_at":    "ISO timestamp"
#   }
#
# stdout failure:
#   { "success": false, "error": "message" }

from __future__ import annotations

import sys
import json
import base64
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field

# ── Silence all logging to stdout — only JSON goes to stdout ──────
logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

# ════════════════════════════════════════════════════════════════════
# CONSTANTS
# ════════════════════════════════════════════════════════════════════

F_SEQ      = 1
F_ID_TYPE  = 2
F_ID_VALUE = 3
F_CKYC_REF = 4

# ════════════════════════════════════════════════════════════════════
# DATA MODEL
# ════════════════════════════════════════════════════════════════════

@dataclass
class CustomerResult:
    pan:       str
    seq:       str
    ckyc_refs: list[str] = field(default_factory=list)

# ════════════════════════════════════════════════════════════════════
# PARSING — unchanged from original logic
# ════════════════════════════════════════════════════════════════════

def parse_response_content(content: str) -> tuple[list[str], list[str]]:
    lines = content.splitlines()

    header_line  = None
    detail_lines = []

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        record_type = line.split('|')[0].strip()
        if record_type == '10':
            header_line = line
        elif record_type == '20':
            detail_lines.append(line)

    if header_line is None:
        raise ValueError("No header (type-10) line found in response file.")
    if not detail_lines:
        raise ValueError("No detail (type-20) lines found in response file.")

    log.info(f"Header: {header_line}")
    log.info(f"Detail lines: {len(detail_lines)}")

    customers: list[CustomerResult] = []
    current:   CustomerResult | None = None

    for line in detail_lines:
        fields   = line.split('|')
        id_type  = fields[F_ID_TYPE].strip()  if len(fields) > F_ID_TYPE  else ''
        id_value = fields[F_ID_VALUE].strip() if len(fields) > F_ID_VALUE else ''
        ckyc_ref = fields[F_CKYC_REF].strip() if len(fields) > F_CKYC_REF else ''
        seq      = fields[F_SEQ].strip()       if len(fields) > F_SEQ      else ''

        if id_type == 'C':
            if current is not None and seq == current.seq:
                if ckyc_ref:
                    current.ckyc_refs.append(ckyc_ref)
                continue

            if current is not None:
                customers.append(current)

            current = CustomerResult(pan=id_value, seq=seq)
            if ckyc_ref:
                current.ckyc_refs.append(ckyc_ref)

        elif id_type == 'E':
            if current is None:
                log.warning(f"Aadhaar line before PAN — skipping: {line}")
                continue
            if ckyc_ref:
                current.ckyc_refs.append(ckyc_ref)

        else:
            if current is not None and ckyc_ref:
                current.ckyc_refs.append(ckyc_ref)

    if current is not None:
        customers.append(current)

    log.info(f"Customer groups: {len(customers)}")

    # ── Classify ──────────────────────────────────────────────────
    found_ckyc_refs: list[str] = []
    not_found_pans:  list[str] = []
    seen_ckyc:       set[str]  = set()
    seen_pans:       set[str]  = set()

    for cust in customers:
        if cust.ckyc_refs:
            for ref in cust.ckyc_refs:
                if ref not in seen_ckyc:
                    seen_ckyc.add(ref)
                    found_ckyc_refs.append(ref)
            log.info(f"  FOUND     PAN={cust.pan:<12}  CKYC={list(dict.fromkeys(cust.ckyc_refs))}")
        else:
            if cust.pan not in seen_pans:
                seen_pans.add(cust.pan)
                not_found_pans.append(cust.pan)
            log.info(f"  NOT FOUND PAN={cust.pan}")

    return found_ckyc_refs, not_found_pans

# ════════════════════════════════════════════════════════════════════
# MAIN — stdin/stdout IPC pattern
# ════════════════════════════════════════════════════════════════════

def main():
    try:
        raw_input = sys.stdin.read()
        payload   = json.loads(raw_input)
    except Exception as e:
        print(json.dumps({ "success": False, "error": f"Failed to read stdin: {e}" }))
        sys.exit(1)

    target_date    = payload.get("target_date")
    batch_sequence = payload.get("batch_sequence")
    file_b64       = payload.get("response_file_content")

    if not file_b64:
        print(json.dumps({ "success": False, "error": "response_file_content is required." }))
        sys.exit(1)

    try:
        # Decode base64 → try UTF-8 then latin-1
        raw_bytes = base64.b64decode(file_b64)
        for enc in ('utf-8', 'utf-8-sig', 'cp1252', 'latin-1'):
            try:
                content = raw_bytes.decode(enc)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        else:
            raise ValueError("Could not decode file content with any supported encoding.")
    except Exception as e:
        print(json.dumps({ "success": False, "error": f"Failed to decode file: {e}" }))
        sys.exit(1)

    try:
        found_ckyc_refs, not_found_pans = parse_response_content(content)
    except Exception as e:
        print(json.dumps({ "success": False, "error": f"Failed to parse response file: {e}" }))
        sys.exit(1)

    result = {
        "success":        True,
        "download_list":  found_ckyc_refs,   # CKYC reference IDs → bulk download
        "upload_list":    not_found_pans,     # PANs not found → upload generator
        "download_count": len(found_ckyc_refs),
        "upload_count":   len(not_found_pans),
        "analyzed_at":    datetime.now(timezone.utc).isoformat(),
    }

    log.info(f"Analysis complete — found: {len(found_ckyc_refs)}, not found: {len(not_found_pans)}")

    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()