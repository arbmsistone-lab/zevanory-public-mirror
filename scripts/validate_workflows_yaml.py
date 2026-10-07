#!/usr/bin/env python3
from pathlib import Path
import re
import sys
import yaml

files = sorted(Path(".github/workflows").glob("*.y*ml"))
if not files:
    raise SystemExit("no workflows found")

bad = []
production_secret_writer = re.compile(
    r"secret\s+put\s+MERCADOPAGO_(?:ACCESS_TOKEN|WEBHOOK_SECRET)"
    r"|secret\s+bulk[\s\S]{0,5000}MERCADOPAGO_(?:ACCESS_TOKEN|WEBHOOK_SECRET)"
    r"|MERCADOPAGO_(?:ACCESS_TOKEN|WEBHOOK_SECRET)[\s\S]{0,5000}secret\s+bulk",
    re.IGNORECASE,
)
allowed_writer = Path(".github/workflows/mercadopago-production-token-rotate.yml")
for path in files:
    try:
        text = path.read_text(encoding="utf-8")
        data = yaml.safe_load(text)
        if not isinstance(data, dict):
            raise ValueError("workflow root must be a mapping")
        if not any(str(k).lower() == "on" for k in data.keys()) and True not in data:
            raise ValueError("missing on trigger")
        if "jobs" not in data:
            raise ValueError("missing jobs")
        if production_secret_writer.search(text) and path != allowed_writer:
            raise ValueError("unauthorized Mercado Pago production secret writer")
        if path == allowed_writer:
            required = ("workflow_dispatch", "/users/me", "site_id", "test_user")
            missing = [item for item in required if item not in text]
            if missing:
                raise ValueError(f"production token rotation guard missing: {missing}")
        print(f"YAML_OK {path}")
    except Exception as exc:
        bad.append((str(path), str(exc)))

if bad:
    for path, exc in bad:
        print(f"YAML_FAIL {path}: {exc}", file=sys.stderr)
    raise SystemExit(1)

print(f"WORKFLOW_YAML_SAFE_LOAD=PASS count={len(files)}")
