#!/usr/bin/env python3
import pathlib
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: verify-live-headers.py <headers-file>")

raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace").lower()
hsts = re.search(r"^strict-transport-security:\s*([^\r\n]+)", raw, re.M)
assert hsts, "missing HSTS"
max_age = re.search(r"max-age=(\d+)", hsts.group(1))
assert max_age and int(max_age.group(1)) >= 31_536_000, hsts.group(1)
assert "includesubdomains" in hsts.group(1), hsts.group(1)

csp_match = re.search(r"^content-security-policy:\s*([^\r\n]+)", raw, re.M)
assert csp_match, "missing CSP"
csp = csp_match.group(1)
for token in (
    "script-src",
    "frame-src",
    "connect-src",
    "sdk.mercadopago.com",
    "api.mercadopago.com",
    "www.mercadopago.com",
):
    assert token in csp, (token, csp)

assert re.search(r"^x-content-type-options:\s*nosniff\s*$", raw, re.M), raw
print("LIVE_HSTS_CSP=PASS")
