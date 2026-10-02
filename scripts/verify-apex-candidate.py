#!/usr/bin/env python3
from pathlib import Path
import json
import urllib.request
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: verify-apex-candidate.py <preview-url>")

base=sys.argv[1].rstrip("/")
required_pages=("solucoes","termos","privacidade","reembolso","afiliados")
for slug in required_pages:
    req=urllib.request.Request(f"{base}/{slug}",headers={"User-Agent":"ZEVANORY-Apex-Candidate/1.0","Accept":"text/html"})
    with urllib.request.urlopen(req,timeout=25) as r:
        body=r.read().decode("utf-8","replace")
        assert r.status==200,(slug,r.status)
        assert len(body)>300,(slug,len(body))
        if slug=="solucoes":
            assert "IA na Prática" in body

worker=Path("worker/cloudflare-worker.recovered.mjs").read_text("utf-8")
for marker in (
    "globally-blocked",
    "operational_commercial_blocked",
    "global_sale_disabled",
    "missing_tables_count",
):
    assert marker in worker, marker

parity=json.loads(Path("evidence/main-edge-parity-contract.json").read_text("utf-8"))
assert isinstance(parity,dict) and parity, "empty main-edge parity contract"

print("APEX_CANDIDATE_LEGAL_SURFACES=PASS")
print("APEX_CANDIDATE_SAFETY_MARKERS=PASS")
print("APEX_CANDIDATE_PARITY_CONTRACT=PASS")
