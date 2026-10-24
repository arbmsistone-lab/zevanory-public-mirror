#!/usr/bin/env python3
"""ZEVANORY | WhatsApp retired (PR #896): fail-closed scan of the PUBLIC assets of the central candidate.

The banned WhatsApp account must not be reachable from any public page: no wa.me, no api.whatsapp.com and
neither number (99254-5413 / 9234-0423) in any format. Used by prepare-central-candidate.py (raises before
the config is written) and by central-candidate-dryrun.yml on the fully built public/ tree.
Usage: public_whatsapp_scan.py [ROOT=public]  -> exit 0 PUBLIC_WHATSAPP_FREE=PASS, exit 1 with every hit.
"""
import re
import sys
from pathlib import Path

# Each retired number in any format: optional +55 / (88) prefix, digits with at most one separator
# (space . - ( ) /) between them; not part of a longer alphanumeric token (hashes, ids).
_SEP = r"[\s.()/\-]?"
def _number_pattern(digits, optional_lead_nine=False):
    lead = r"(?:9" + _SEP + r")?" if optional_lead_nine else ""
    return re.compile(r"(?<![0-9A-Za-z])(?:\+?55" + _SEP + r")?(?:\(?88\)?" + _SEP + r")?" + lead + _SEP.join(digits) + r"(?![0-9A-Za-z])")
PUBLIC_WHATSAPP_PATTERNS = (
    ("wa.me", re.compile(r"wa\.me", re.I)),
    ("api.whatsapp.com", re.compile(r"api\.whatsapp\.com", re.I)),
    ("number 99254-5413", _number_pattern("92545413", optional_lead_nine=True)),
    ("number 9234-0423", _number_pattern("92340423")),
)
def public_whatsapp_hits(root="public"):
    hits = []
    for asset in sorted(Path(root).rglob("*")):
        if not asset.is_file():
            continue
        try:
            text = asset.read_bytes().decode("utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary asset (png, woff...)
        hits += [f"{asset.as_posix()}:{name}" for name, rx in PUBLIC_WHATSAPP_PATTERNS if rx.search(text)]
    return hits


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "public"
    if not Path(root).is_dir():
        print(f"PUBLIC_WHATSAPP_SCAN_ROOT_MISSING {root}")
        sys.exit(1)
    found = public_whatsapp_hits(root)
    for hit in found:
        print("PUBLIC_WHATSAPP_CONTACT_PRESENT " + hit)
    print("PUBLIC_WHATSAPP_FREE=" + ("FAIL" if found else "PASS"))
    sys.exit(1 if found else 0)
