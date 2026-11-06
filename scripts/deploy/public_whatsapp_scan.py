#!/usr/bin/env python3
"""ZEVANORY | WhatsApp retired (PR #896): fail-closed scan of the PUBLIC assets of the central candidate.

The banned WhatsApp account must not be reachable from any public page: no wa.me, no api.whatsapp.com and
neither number (99254-5413 / 9234-0423) in any format. Used by prepare-central-candidate.py (raises before
the config is written) and by central-candidate-dryrun.yml on the fully built public/ tree.
Usage: public_whatsapp_scan.py [ROOT=public]  -> exit 0 PUBLIC_WHATSAPP_FREE=PASS, exit 1 with every hit.
       public_whatsapp_scan.py --workflows [DIR=.github/workflows]  -> WORKFLOWS_WHATSAPP_FREE=PASS|FAIL: no workflow
       may assign SUPPORT_CHANNEL / ZEVANORY_WHATSAPP_* (subscript, YAML/env key, JSON key, setdefault, secret put,
       --var) nor carry either number in any format. Guards that only NAME the aliases (grep, ==, pop) are allowed.
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

_ALIAS = r"(?:SUPPORT_CHANNEL|ZEVANORY_WHATSAPP_[A-Z0-9_]*)"
WORKFLOW_ALIAS_ASSIGNMENTS = (
    re.compile(r"\[\s*[\"']" + _ALIAS + r"[\"']\s*\]\s*=(?!=)"),
    re.compile(r"^\s*(?:-\s*)?(?:export\s+)?" + _ALIAS + r"\s*[:=]", re.M),
    re.compile(r"[\"']" + _ALIAS + r"[\"']\s*:"),
    re.compile(r"setdefault\(\s*[\"']" + _ALIAS),
    re.compile(r"(?:secret\s+put|--var)\s+" + _ALIAS),
)


def workflow_whatsapp_hits(root=".github/workflows"):
    hits = []
    for wf in sorted(list(Path(root).glob("*.yml")) + list(Path(root).glob("*.yaml"))):
        text = wf.read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n")
        if any(rx.search(text) for rx in WORKFLOW_ALIAS_ASSIGNMENTS):
            hits.append(f"{wf.as_posix()}:alias_assignment")
        hits += [f"{wf.as_posix()}:{name}" for name, rx in PUBLIC_WHATSAPP_PATTERNS[2:] if rx.search(text)]
    return hits


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--workflows":
        root = sys.argv[2] if len(sys.argv) > 2 else ".github/workflows"
        if not Path(root).is_dir():
            print(f"WORKFLOWS_WHATSAPP_SCAN_ROOT_MISSING {root}")
            sys.exit(1)
        found = workflow_whatsapp_hits(root)
        for hit in found:
            print("WORKFLOW_WHATSAPP_ALIAS_OR_NUMBER " + hit)
        print("WORKFLOWS_WHATSAPP_FREE=" + ("FAIL" if found else "PASS"))
        sys.exit(1 if found else 0)
    root = sys.argv[1] if len(sys.argv) > 1 else "public"
    if not Path(root).is_dir():
        print(f"PUBLIC_WHATSAPP_SCAN_ROOT_MISSING {root}")
        sys.exit(1)
    found = public_whatsapp_hits(root)
    for hit in found:
        print("PUBLIC_WHATSAPP_CONTACT_PRESENT " + hit)
    print("PUBLIC_WHATSAPP_FREE=" + ("FAIL" if found else "PASS"))
    sys.exit(1 if found else 0)
