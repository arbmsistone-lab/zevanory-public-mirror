#!/usr/bin/env python3
"""Read back the EXACT public PNG bytes after the canonical Cloudflare deploy.

Use curl, matching the established release/health probes. A binary mismatch,
redirect, WAF denial, missing object or stale cache is a real deployment failure.
Only bounded retries are allowed; this script cannot downgrade the brand gate.
"""
import hashlib
import json
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "assets/brand/export/manifest.json").read_text(encoding="utf8"))
BASE = "https://zevanory.api.br/brand/export/"
MAX_ATTEMPTS = 18
RETRY_SECONDS = 5


def probe(filename):
    with tempfile.TemporaryDirectory(prefix="zevanory-brand-probe-") as directory:
        body = Path(directory) / "response.png"
        headers = Path(directory) / "headers.txt"
        argv = [
            "curl", "--silent", "--show-error", "--max-time", "15",
            "--output", str(body), "--dump-header", str(headers),
            "--write-out", "%{http_code}", "--request", "GET",
            "--header", "Accept: image/png",
            "--header", "Cache-Control: no-cache",
            BASE + filename,
        ]
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=18, check=False)
            code = result.stdout.strip() or "000"
            raw = body.read_bytes() if body.is_file() else b""
            head = headers.read_text(errors="replace") if headers.is_file() else ""
            content_type = next(
                (line.split(":", 1)[1].strip().lower() for line in head.splitlines()
                 if line.lower().startswith("content-type:")), "unavailable"
            )
            return {
                "status": code, "body": raw, "curl_exit": result.returncode,
                "content_type": content_type, "stderr": (result.stderr or "").strip()[:160],
            }
        except (OSError, subprocess.TimeoutExpired) as error:
            return {
                "status": "000", "body": b"", "curl_exit": -1,
                "content_type": "unavailable", "stderr": type(error).__name__,
            }


def verify():
    verified = []
    for filename, expected in sorted(MANIFEST.items()):
        last = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            response = probe(filename)
            raw = response["body"]
            digest = hashlib.sha256(raw).hexdigest()
            last = {
                "file": filename,
                "status": response["status"],
                "curl_exit": response["curl_exit"],
                "bytes": len(raw),
                "sha256_12": digest[:12],
                "expected_sha256_12": expected["sha256"][:12],
                "content_type": response["content_type"],
                "stderr": response["stderr"],
                "attempt": attempt,
            }
            if (
                response["curl_exit"] == 0 and response["status"] == "200"
                and response["content_type"].startswith("image/")
                and raw.startswith(b"\x89PNG\r\n\x1a\n")
                and len(raw) == expected["size"]
                and digest == expected["sha256"]
            ):
                print("BRAND_LIVE_ASSET=PASS", filename, len(raw), digest[:12])
                verified.append(filename)
                break
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_SECONDS)
        else:
            print("BRAND_LIVE_READBACK_DIAGNOSTIC=" + json.dumps(last, sort_keys=True))
            raise SystemExit("BRAND_LIVE_ASSET_UNVERIFIED " + filename)
    if len(verified) != len(MANIFEST):
        raise SystemExit("BRAND_LIVE_COMPLETENESS_MISMATCH")
    print("BRAND_LIVE_ALL_EXACT_DIGESTS=PASS", len(verified))


if __name__ == "__main__":
    verify()
