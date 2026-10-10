#!/usr/bin/env python3
"""Verify exact on-the-wire contents after Cloudflare canonical deploy."""
import hashlib,json,time,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
MANIFEST=json.loads((ROOT/"assets/brand/export/manifest.json").read_text())
BASE="https://zevanory.api.br/brand/export/"
for name,row in sorted(MANIFEST.items()):
    ok=False
    for retry in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE+name,headers={"Accept":"image/png","Cache-Control":"no-cache"}),timeout=12) as res:
                raw=res.read(1_000_001)
                if res.status==200 and raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw)==row["size"] and hashlib.sha256(raw).hexdigest()==row["sha256"]:
                    ok=True;break
        except (OSError,ValueError):pass
        time.sleep(3)
    if not ok:raise SystemExit("BRAND_LIVE_ASSET_UNVERIFIED "+name)
print("BRAND_LIVE_ALL_EXACT_DIGESTS=PASS",len(MANIFEST))
